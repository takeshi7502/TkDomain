'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA';
type DnsRecord = { id: string; recordType: RecordType; recordName: string; content: string; ttl: number; proxied: boolean; priority: number | null; isPrimary: boolean };
type ManagedSubdomain = { id: string; label: string; status: string; records: DnsRecord[] };
type OwnerSession = { type: 'owner'; owner: { telegramUsername: string | null }; subdomains: Array<{ id: string; label: string; status: string }> };
type RequestSession = {
  type: 'pending' | 'rejected';
  request: {
    id: string;
    hostname: string;
    cnameTarget: string;
    telegramUsername: string | null;
    status: 'pending' | 'rejected';
    createdAt: number;
    reviewedAt: number | null;
    reviewerNote: string | null;
  };
};
type SessionData = OwnerSession | RequestSession;
type EditableRecord = { recordType: RecordType; recordName: string; content: string; ttl: number; proxied: boolean; priority: string };
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

const proxyable = new Set<RecordType>(['A', 'AAAA', 'CNAME']);
const blankRecord = (): EditableRecord => ({ recordType: 'A', recordName: '@', content: '', ttl: 1, proxied: false, priority: '' });

function recordHost(label: string, name: string) {
  return name === '@' ? `${label}.takeshi.dev` : `${name}.${label}.takeshi.dev`;
}

function ttlLabel(ttl: number) {
  return ttl === 1 ? 'Auto' : `${ttl}s`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export default function ManagePage() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [subdomains, setSubdomains] = useState<ManagedSubdomain[]>([]);
  const [accessKey, setAccessKey] = useState('');
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [accessKeyTouched, setAccessKeyTouched] = useState(false);
  const [loginKeyRejected, setLoginKeyRejected] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [record, setRecord] = useState<EditableRecord>(blankRecord());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [cancelRequestOpen, setCancelRequestOpen] = useState(false);
  const [cancelRequestConfirmation, setCancelRequestConfirmation] = useState('');
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [notice, setNotice] = useState<Notice>(null);

  const selected = useMemo(() => subdomains.find((item) => item.id === selectedId) ?? subdomains[0] ?? null, [selectedId, subdomains]);
  const primaryRecord = useMemo(() => selected?.records.find((item) => item.isPrimary) ?? null, [selected]);
  const secondaryRecords = useMemo(() => selected?.records.filter((item) => !item.isPrimary) ?? [], [selected]);
  const confirmationTarget = selected ? `${selected.label}.takeshi.dev` : '';
  const accessKeyInvalid = accessKeyTouched && (accessKey.trim().length === 0 || loginKeyRejected);

  async function loadPanel(): Promise<SessionData | null> {
    try {
      const sessionResponse = await fetch('/api/manage/session');
      if (!sessionResponse.ok) {
        setSession(null);
        setSubdomains([]);
        setSelectedId('');
        return null;
      }
      const sessionPayload = await sessionResponse.json() as SessionData;
      setSession(sessionPayload);
      if (sessionPayload.type !== 'owner') {
        setSubdomains([]);
        setSelectedId('');
        return sessionPayload;
      }

      const recordsResponse = await fetch('/api/manage/records');
      const recordsPayload = await recordsResponse.json() as { subdomains?: ManagedSubdomain[]; error?: string };
      if (!recordsResponse.ok || !recordsPayload.subdomains) {
        setNotice({ tone: 'error', text: recordsPayload.error ?? 'Không thể tải DNS records.' });
        return null;
      }
      setSubdomains(recordsPayload.subdomains);
      setSelectedId((current) => recordsPayload.subdomains?.some((domain) => domain.id === current) ? current : recordsPayload.subdomains?.[0]?.id || '');
      return sessionPayload;
    } catch {
      setNotice({ tone: 'error', text: 'Không thể kết nối DNS panel.' });
      return null;
    } finally {
      setState('idle');
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void loadPanel(); }, 0);
    return () => window.clearTimeout(initialLoad);
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    setAccessKeyTouched(true);
    if (!accessKey.trim()) {
      setLoginKeyRejected(false);
      setNotice({ tone: 'error', text: 'Nhập access key trước khi mở DNS panel.' });
      return;
    }
    setState('saving');
    setNotice(null);
    try {
      const response = await fetch('/api/manage/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setState('idle');
        setLoginKeyRejected(response.status === 400 || response.status === 401);
        setNotice({ tone: 'error', text: payload.error ?? 'Không thể mở DNS panel.' });
        return;
      }
      setAccessKey('');
      setAccessKeyTouched(false);
      setLoginKeyRejected(false);
      await loadPanel();
    } catch {
      setState('idle');
      setNotice({ tone: 'error', text: 'Không thể kết nối DNS panel. Hãy thử lại.' });
    }
  }

  function resetForm() {
    setRecord(blankRecord());
    setEditingId(null);
  }

  function editRecord(item: DnsRecord) {
    setDeletePanelOpen(false);
    setEditingId(item.id);
    setRecord({ recordType: item.recordType, recordName: item.recordName, content: item.content, ttl: item.ttl, proxied: item.proxied, priority: item.priority?.toString() ?? '' });
    setNotice({ tone: 'info', text: item.isPrimary ? 'Đang sửa record chính của subdomain.' : 'Đang sửa record đã chọn.' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveRecord(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setState('saving');
    setNotice(null);
    const body = { ...record, subdomainId: selected.id, priority: record.priority === '' ? null : Number(record.priority) };
    const response = await fetch('/api/manage/records', { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editingId ? { ...body, id: editingId } : body) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setState('idle');
      setNotice({ tone: 'error', text: payload.error ?? 'Không thể lưu DNS record.' });
      return;
    }
    resetForm();
    await loadPanel();
    setNotice({ tone: 'success', text: 'DNS record đã được cập nhật trên Cloudflare.' });
  }

  async function deleteRecord(item: DnsRecord) {
    if (!selected || !window.confirm(`Xóa ${item.recordType} ${item.recordName} khỏi ${selected.label}.takeshi.dev?`)) return;
    setState('saving');
    setNotice(null);
    const response = await fetch(`/api/manage/records?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setState('idle');
      setNotice({ tone: 'error', text: payload.error ?? 'Không thể xóa DNS record.' });
      return;
    }
    if (editingId === item.id) resetForm();
    await loadPanel();
    setNotice({ tone: 'success', text: 'DNS record đã được xóa.' });
  }

  async function deleteSubdomain(event: FormEvent) {
    event.preventDefault();
    if (!selected || deleteConfirmation !== confirmationTarget) return;
    setState('saving');
    setNotice(null);
    const response = await fetch('/api/manage/subdomains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subdomainId: selected.id, confirmation: deleteConfirmation }) });
    const payload = await response.json() as { error?: string; ownerDeleted?: boolean; hostname?: string };
    if (!response.ok) {
      setState('idle');
      setNotice({ tone: 'error', text: payload.error ?? 'Không thể xóa subdomain.' });
      return;
    }
    resetForm();
    setDeleteConfirmation('');
    setDeletePanelOpen(false);
    if (payload.ownerDeleted) {
      await fetch('/api/manage/session', { method: 'DELETE' });
      setSession(null);
      setSubdomains([]);
      setSelectedId('');
      setState('idle');
    } else {
      await loadPanel();
    }
    setNotice({ tone: 'success', text: `${payload.hostname ?? confirmationTarget} đã bị xóa cùng toàn bộ DNS records. Lịch sử đăng ký được giữ lại trong registry.` });
  }

  async function refreshRequestStatus() {
    setState('loading');
    setNotice(null);
    const nextSession = await loadPanel();
    if (nextSession?.type === 'owner') setNotice({ tone: 'success', text: 'Yêu cầu đã được duyệt. DNS panel của bạn đã sẵn sàng.' });
  }

  async function cancelRequest(event: FormEvent) {
    event.preventDefault();
    if (!session || session.type !== 'pending' || cancelRequestConfirmation !== session.request.hostname) return;
    setState('saving');
    setNotice(null);
    try {
      const response = await fetch('/api/manage/pending-request', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: cancelRequestConfirmation }),
      });
      const payload = await response.json() as { error?: string; hostname?: string };
      if (!response.ok) {
        setState('idle');
        setNotice({ tone: 'error', text: payload.error ?? 'Không thể hủy yêu cầu.' });
        return;
      }
      setSession(null);
      setSubdomains([]);
      setSelectedId('');
      setCancelRequestOpen(false);
      setCancelRequestConfirmation('');
      setState('idle');
      setNotice({ tone: 'success', text: `${payload.hostname ?? 'Yêu cầu'} đã được hủy. Tên này hiện có thể được đăng ký lại.` });
    } catch {
      setState('idle');
      setNotice({ tone: 'error', text: 'Không thể kết nối để hủy yêu cầu. Hãy thử lại.' });
    }
  }

  async function logout() {
    await fetch('/api/manage/session', { method: 'DELETE' });
    setSession(null);
    setSubdomains([]);
    setSelectedId('');
    resetForm();
    setDeletePanelOpen(false);
    setCancelRequestOpen(false);
    setNotice(null);
  }

  if (!session) {
    return (
      <main className="manage-page">
        <div className="manage-shell narrow-shell">
          <Link href="/" className="back-link">← Về trang đăng ký</Link>
          <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>Nhập access key bạn đã tự đặt khi đăng ký. Key chỉ tạo phiên trên thiết bị này.</p></div>
          <form className="panel access-form" noValidate onSubmit={login}>
            <label htmlFor="owner-key">Owner access key
              <div className="key-input">
                <input id="owner-key" className={`field${accessKeyInvalid ? ' invalid' : ''}`} type={showAccessKey ? 'text' : 'password'} placeholder="tk-your-access-key" value={accessKey} onChange={(event) => { setAccessKey(event.target.value); setAccessKeyTouched(false); setLoginKeyRejected(false); setNotice(null); }} onBlur={() => setAccessKeyTouched(true)} autoComplete="off" required />
                <button className="visibility-toggle" type="button" onClick={() => setShowAccessKey((visible) => !visible)} aria-label={showAccessKey ? 'Ẩn access key' : 'Hiện access key'} title={showAccessKey ? 'Ẩn access key' : 'Hiện access key'}>{showAccessKey ? '⊙' : '◉'}</button>
              </div>
            </label>
            {accessKeyInvalid && <small className="field-bad access-key-feedback">Nhập đầy đủ access key, gồm cả tiền tố tk-.</small>}
            <a className="lost-key-link" href="https://t.me/jinndesu" target="_blank" rel="noreferrer">Quên hoặc mất access key? Liên hệ Admin</a>
            {notice && <p className={`form-message ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
            <button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang mở...' : 'Mở DNS panel'}</button>
          </form>
        </div>
      </main>
    );
  }

  if (session.type !== 'owner') {
    const isPending = session.type === 'pending';
    const request = session.request;
    return (
      <main className="manage-page">
        <div className="manage-shell narrow-shell">
          <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><button className="text-button" type="button" onClick={logout}>Đăng xuất</button></header>
          <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> REQUEST STATUS</p><h1>{isPending ? 'Đang chờ duyệt' : 'Yêu cầu đã từ chối'}</h1></div><p>{isPending ? 'Access key của bạn đã được xác thực, nhưng DNS sẽ chỉ mở sau khi admin duyệt yêu cầu.' : 'Bạn có thể xem lại thông tin bên dưới hoặc gửi một yêu cầu mới.'}</p></div>
          <section className={`panel pending-request-panel${isPending ? '' : ' rejected-request-panel'}`}>
            <div className="pending-request-head"><div><p className="eyebrow"><span className="pixel-dot" /> {isPending ? 'WAITING FOR REVIEW' : 'REQUEST CLOSED'}</p><h2>{request.hostname}</h2></div><span className={`status ${isPending ? 'pending' : 'rejected'}`}>{isPending ? 'pending' : 'rejected'}</span></div>
            <div className="request-details pending-request-details"><div>CNAME<strong>{request.cnameTarget}</strong></div><div>Telegram<strong>{request.telegramUsername ? `@${request.telegramUsername}` : 'Không có'}</strong></div><div>Gửi lúc<strong>{formatDate(request.createdAt)}</strong></div></div>
            {request.reviewerNote && <p className="note">Lý do từ chối từ admin: {request.reviewerNote}</p>}
            {isPending ? <><p className="pending-copy">Chưa có DNS record nào được tạo và bạn chưa thể sửa DNS trong lúc chờ. Nếu admin vừa duyệt, hãy tải lại trạng thái để mở panel ngay.</p><div className="editor-actions pending-actions"><button type="button" className="button secondary-action" onClick={() => void refreshRequestStatus()} disabled={state !== 'idle'}>{state === 'loading' ? 'Đang kiểm tra...' : 'Tải lại trạng thái'}</button><button type="button" className="button reject" onClick={() => { setCancelRequestOpen((open) => !open); setCancelRequestConfirmation(''); }}>Hủy yêu cầu</button></div></> : <div className="pending-actions"><Link className="button secondary-action" href="/">Gửi yêu cầu mới</Link></div>}
          </section>
          {isPending && cancelRequestOpen && <section className="panel cancel-request-panel"><p className="eyebrow"><span className="pixel-dot" /> CONFIRM CANCELLATION</p><h2>Hủy {request.hostname}</h2><p>Yêu cầu sẽ được lưu lại trong lịch sử là “đã tự hủy”; không có DNS nào bị xóa vì DNS chưa được tạo. Tên này sẽ có thể đăng ký lại.</p><form onSubmit={cancelRequest}><label htmlFor="cancel-request-confirm">Nhập chính xác <code>{request.hostname}</code><input id="cancel-request-confirm" className="field" value={cancelRequestConfirmation} onChange={(event) => setCancelRequestConfirmation(event.target.value)} autoComplete="off" placeholder={request.hostname} required /></label><div className="editor-actions"><button className="button destructive" type="submit" disabled={state !== 'idle' || cancelRequestConfirmation !== request.hostname}>{state === 'saving' ? 'Đang hủy...' : 'Tôi hiểu, hủy yêu cầu'}</button><button type="button" className="button cancel" onClick={() => { setCancelRequestOpen(false); setCancelRequestConfirmation(''); }}>Quay lại</button></div></form></section>}
          {notice && <p className={`form-message ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        </div>
      </main>
    );
  }

  return <main className="manage-page"><div className="manage-shell">
    <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><button className="text-button" type="button" onClick={logout}>Đăng xuất</button></header>
    <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>{session.owner.telegramUsername ? `@${session.owner.telegramUsername}` : 'Owner account'}<br />Chỉ các record thuộc subdomain của bạn mới hiển thị ở đây.</p></div>
    {subdomains.length === 0 ? <><div className="panel empty-state">Chưa có subdomain active cho access key này.</div>{notice && <p className={`form-message ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}</> : <>
      <div className="domain-tabs" role="tablist">{subdomains.map((domain) => <button type="button" key={domain.id} className={domain.id === selected?.id ? 'domain-tab active' : 'domain-tab'} onClick={() => { setSelectedId(domain.id); resetForm(); setDeletePanelOpen(false); }}>{domain.label}.takeshi.dev</button>)}</div>
      {selected && <>
        <section className="panel primary-domain-panel"><div className="primary-domain-heading"><div><p className="eyebrow"><span className="pixel-dot" /> PRIMARY SUBDOMAIN</p><h2>{selected.label}<span>.takeshi.dev</span></h2><p>Đây là subdomain bạn đã đăng ký. Record chính luôn được ghim ở đây.</p></div><span className="status active">PRIMARY</span></div>{primaryRecord ? <div className="primary-record-summary"><span className="record-type">{primaryRecord.recordType}</span><div><strong>{recordHost(selected.label, primaryRecord.recordName)}</strong><code>{primaryRecord.content}</code><small>{ttlLabel(primaryRecord.ttl)}{primaryRecord.proxied ? ' · proxied' : ' · DNS only'}</small></div><div className="primary-record-actions"><button className="icon-action" type="button" onClick={() => editRecord(primaryRecord)} aria-label="Sửa record chính" title="Sửa record chính">✎</button><button className="icon-action destructive-icon" type="button" onClick={() => { setDeletePanelOpen((open) => !open); setDeleteConfirmation(''); }} aria-label="Xóa toàn bộ subdomain" title="Xóa toàn bộ subdomain">×</button></div></div> : <p className="empty-copy">Không tìm thấy record chính. Hãy liên hệ admin.</p>}</section>
        {deletePanelOpen && <section className="panel delete-subdomain-panel"><p className="eyebrow"><span className="pixel-dot" /> DANGER ZONE</p><h2>Xóa {confirmationTarget}</h2><p>Thao tác này xóa toàn bộ DNS records và quyền panel của subdomain. Lịch sử đăng ký vẫn được giữ lại, còn tên sẽ trở về trạng thái có thể đăng ký.</p><form onSubmit={deleteSubdomain}><label htmlFor="delete-confirm">Nhập chính xác <code>{confirmationTarget}</code><input id="delete-confirm" className="field" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" placeholder={confirmationTarget} required /></label><div className="editor-actions"><button className="button destructive" type="submit" disabled={state !== 'idle' || deleteConfirmation !== confirmationTarget}>{state === 'saving' ? 'Đang xóa...' : 'Tôi hiểu, xóa toàn bộ'}</button><button type="button" className="button cancel" onClick={() => { setDeletePanelOpen(false); setDeleteConfirmation(''); }}>Hủy</button></div></form></section>}
        <div className="manage-grid">
          <section className="panel record-editor"><div className="panel-heading"><span className="block-mark" /><div><p>{editingId ? (editingId === primaryRecord?.id ? 'EDIT PRIMARY RECORD' : 'EDIT RECORD') : 'NEW CHILD RECORD'}</p><h2>{editingId ? (editingId === primaryRecord?.id ? 'Sửa record chính' : 'Sửa DNS record') : 'Thêm record con'}</h2></div></div><form onSubmit={saveRecord}><div className="form-pair"><label>Type<select className="field" value={record.recordType} onChange={(event) => { const recordType = event.target.value as RecordType; setRecord((value) => ({ ...value, recordType, proxied: proxyable.has(recordType) ? value.proxied : false, priority: recordType === 'MX' ? value.priority : '' })); }}>{(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as RecordType[]).map((type) => <option value={type} key={type}>{type}</option>)}</select></label><label>Name<input className="field" value={record.recordName} onChange={(event) => setRecord((value) => ({ ...value, recordName: event.target.value }))} placeholder="@ hoặc web" required /></label></div><label>Content<input className="field" value={record.content} onChange={(event) => setRecord((value) => ({ ...value, content: event.target.value }))} placeholder={record.recordType === 'A' ? '203.0.113.10' : record.recordType === 'TXT' ? 'verification=value' : record.recordType === 'CAA' ? '0 issue letsencrypt.org' : 'target.example.com'} required /><small>{record.recordType === 'CAA' ? 'Ví dụ: 0 issue letsencrypt.org' : `Sẽ tạo tại ${recordHost(selected.label, record.recordName || '@')}`}</small></label><div className="form-pair"><label>TTL<select className="field" value={record.ttl} onChange={(event) => setRecord((value) => ({ ...value, ttl: Number(event.target.value) }))}><option value={1}>Auto</option><option value={60}>60 giây</option><option value={300}>5 phút</option><option value={3600}>1 giờ</option></select></label>{record.recordType === 'MX' && <label>Priority<input className="field" type="number" min="0" max="65535" value={record.priority} onChange={(event) => setRecord((value) => ({ ...value, priority: event.target.value }))} required /></label>}</div>{proxyable.has(record.recordType) && <label className="check-row proxy-row"><input type="checkbox" checked={record.proxied} onChange={(event) => setRecord((value) => ({ ...value, proxied: event.target.checked }))} /><span>Proxy qua Cloudflare <small>Chỉ bật cho web traffic HTTP/HTTPS.</small></span></label>}{notice && <p className={`form-message ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}<div className="editor-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang lưu...' : editingId ? 'Lưu thay đổi' : 'Tạo record'}</button>{editingId && <button type="button" className="button cancel" onClick={resetForm}>Hủy</button>}</div></form></section>
          <section className="panel records-panel"><div className="records-heading"><p className="eyebrow"><span className="pixel-dot" /> CHILD RECORDS</p><span className="status">{secondaryRecords.length} records</span></div><div className="record-list">{secondaryRecords.length === 0 ? <p className="empty-copy">Chưa có record con nào.</p> : secondaryRecords.map((item) => <article className="record-row" key={item.id}><div className="record-main"><span className="record-type">{item.recordType}</span><div><strong>{recordHost(selected.label, item.recordName)}</strong><code>{item.content}{item.priority !== null ? ` · priority ${item.priority}` : ''}</code><small>{ttlLabel(item.ttl)}{item.proxied ? ' · proxied' : ' · DNS only'}</small></div></div><div className="record-actions"><button type="button" className="record-action" onClick={() => editRecord(item)}>Sửa</button><button type="button" className="record-action danger-action" onClick={() => void deleteRecord(item)} disabled={state !== 'idle'}>Xóa</button></div></article>)}</div></section>
        </div>
      </>}
    </>}
  </div></main>;
}
