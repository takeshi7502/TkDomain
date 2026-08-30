'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA';
type DnsRecord = { id: string; recordType: RecordType; recordName: string; content: string; ttl: number; proxied: boolean; priority: number | null; isPrimary: boolean };
type ManagedSubdomain = { id: string; label: string; status: string; records: DnsRecord[] };
type SessionData = { owner: { email: string; githubHandle: string | null }; subdomains: Array<{ id: string; label: string; status: string }> };
type EditableRecord = { recordType: RecordType; recordName: string; content: string; ttl: number; proxied: boolean; priority: string };

const proxyable = new Set<RecordType>(['A', 'AAAA', 'CNAME']);
const blankRecord = (): EditableRecord => ({ recordType: 'A', recordName: '@', content: '', ttl: 1, proxied: false, priority: '' });

function recordHost(label: string, name: string) {
  return name === '@' ? `${label}.takeshi.dev` : `${name}.${label}.takeshi.dev`;
}

function ttlLabel(ttl: number) {
  return ttl === 1 ? 'Auto' : `${ttl}s`;
}

export default function ManagePage() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [subdomains, setSubdomains] = useState<ManagedSubdomain[]>([]);
  const [accessKey, setAccessKey] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [record, setRecord] = useState<EditableRecord>(blankRecord());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [message, setMessage] = useState('');

  const selected = useMemo(() => subdomains.find((item) => item.id === selectedId) ?? subdomains[0] ?? null, [selectedId, subdomains]);
  const primaryRecord = useMemo(() => selected?.records.find((item) => item.isPrimary) ?? null, [selected]);
  const secondaryRecords = useMemo(() => selected?.records.filter((item) => !item.isPrimary) ?? [], [selected]);
  const confirmationTarget = selected ? `${selected.label}.takeshi.dev` : '';
  const positiveMessage = /đã|Đang sửa|sẵn sàng/i.test(message);

  async function loadPanel() {
    try {
      const sessionResponse = await fetch('/api/manage/session');
      if (!sessionResponse.ok) {
        setSession(null);
        setSubdomains([]);
        return;
      }
      const sessionPayload = await sessionResponse.json() as SessionData;
      const recordsResponse = await fetch('/api/manage/records');
      const recordsPayload = await recordsResponse.json() as { subdomains?: ManagedSubdomain[]; error?: string };
      if (!recordsResponse.ok || !recordsPayload.subdomains) {
        setMessage(recordsPayload.error ?? 'Không thể tải DNS records.');
        return;
      }
      setSession(sessionPayload);
      setSubdomains(recordsPayload.subdomains);
      setSelectedId((current) => recordsPayload.subdomains?.some((domain) => domain.id === current) ? current : recordsPayload.subdomains?.[0]?.id || '');
    } catch {
      setMessage('Không thể kết nối DNS panel.');
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
    setState('saving');
    setMessage('');
    const response = await fetch('/api/manage/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setState('idle');
      setMessage(payload.error ?? 'Không thể mở DNS panel.');
      return;
    }
    setAccessKey('');
    await loadPanel();
  }

  function resetForm() {
    setRecord(blankRecord());
    setEditingId(null);
  }

  function editRecord(item: DnsRecord) {
    setDeletePanelOpen(false);
    setEditingId(item.id);
    setRecord({ recordType: item.recordType, recordName: item.recordName, content: item.content, ttl: item.ttl, proxied: item.proxied, priority: item.priority?.toString() ?? '' });
    setMessage(item.isPrimary ? 'Đang sửa record chính của subdomain.' : 'Đang sửa record đã chọn.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveRecord(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setState('saving');
    setMessage('');
    const body = { ...record, subdomainId: selected.id, priority: record.priority === '' ? null : Number(record.priority) };
    const response = await fetch('/api/manage/records', { method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editingId ? { ...body, id: editingId } : body) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setState('idle');
      setMessage(payload.error ?? 'Không thể lưu DNS record.');
      return;
    }
    resetForm();
    await loadPanel();
    setMessage('DNS record đã được cập nhật trên Cloudflare.');
  }

  async function deleteRecord(item: DnsRecord) {
    if (!selected || !window.confirm(`Xóa ${item.recordType} ${item.recordName} khỏi ${selected.label}.takeshi.dev?`)) return;
    setState('saving');
    setMessage('');
    const response = await fetch(`/api/manage/records?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setState('idle');
      setMessage(payload.error ?? 'Không thể xóa DNS record.');
      return;
    }
    if (editingId === item.id) resetForm();
    await loadPanel();
    setMessage('DNS record đã được xóa.');
  }

  async function deleteSubdomain(event: FormEvent) {
    event.preventDefault();
    if (!selected || deleteConfirmation !== confirmationTarget) return;
    setState('saving');
    setMessage('');
    const response = await fetch('/api/manage/subdomains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subdomainId: selected.id, confirmation: deleteConfirmation }) });
    const payload = await response.json() as { error?: string; ownerDeleted?: boolean; hostname?: string };
    if (!response.ok) {
      setState('idle');
      setMessage(payload.error ?? 'Không thể xóa subdomain.');
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
    setMessage(`${payload.hostname ?? confirmationTarget} đã bị xóa cùng toàn bộ DNS record liên quan.`);
  }

  async function logout() {
    await fetch('/api/manage/session', { method: 'DELETE' });
    setSession(null);
    setSubdomains([]);
    setSelectedId('');
    resetForm();
    setDeletePanelOpen(false);
  }

  if (!session) {
    return <main className="manage-page"><div className="manage-shell narrow-shell"><Link href="/" className="back-link">← Về trang đăng ký</Link><div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>Nhập access key mà admin gửi riêng cho bạn. Key chỉ tạo phiên trên thiết bị này.</p></div><form className="panel access-form" onSubmit={login}><label htmlFor="owner-key">Owner access key<input id="owner-key" className="field" type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="off" required /></label>{message && <p className={`form-message ${positiveMessage ? 'success' : 'error'}`}>{message}</p>}<button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang mở...' : 'Mở DNS panel'}</button></form></div></main>;
  }

  return <main className="manage-page"><div className="manage-shell">
    <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><button className="text-button" type="button" onClick={logout}>Đăng xuất</button></header>
    <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>{session.owner.email}<br />Chỉ các record thuộc subdomain của bạn mới hiển thị ở đây.</p></div>
    {subdomains.length === 0 ? <><div className="panel empty-state">Chưa có subdomain active cho access key này.</div>{message && <p className={`form-message ${positiveMessage ? 'success' : 'error'}`}>{message}</p>}</> : <>
      <div className="domain-tabs" role="tablist">{subdomains.map((domain) => <button type="button" key={domain.id} className={domain.id === selected?.id ? 'domain-tab active' : 'domain-tab'} onClick={() => { setSelectedId(domain.id); resetForm(); setDeletePanelOpen(false); }}>{domain.label}.takeshi.dev</button>)}</div>
      {selected && <>
        <section className="panel primary-domain-panel"><div className="primary-domain-heading"><div><p className="eyebrow"><span className="pixel-dot" /> PRIMARY SUBDOMAIN</p><h2>{selected.label}<span>.takeshi.dev</span></h2><p>Đây là subdomain bạn đã đăng ký. Record chính luôn được ghim ở đây.</p></div><span className="status active">PRIMARY</span></div>{primaryRecord ? <div className="primary-record-summary"><span className="record-type">{primaryRecord.recordType}</span><div><strong>{recordHost(selected.label, primaryRecord.recordName)}</strong><code>{primaryRecord.content}</code><small>{ttlLabel(primaryRecord.ttl)}{primaryRecord.proxied ? ' · proxied' : ' · DNS only'}</small></div><div className="primary-record-actions"><button className="icon-action" type="button" onClick={() => editRecord(primaryRecord)} aria-label="Sửa record chính" title="Sửa record chính">✎</button><button className="icon-action destructive-icon" type="button" onClick={() => { setDeletePanelOpen((open) => !open); setDeleteConfirmation(''); }} aria-label="Xóa toàn bộ subdomain" title="Xóa toàn bộ subdomain">×</button></div></div> : <p className="empty-copy">Không tìm thấy record chính. Hãy liên hệ admin.</p>}</section>
        {deletePanelOpen && <section className="panel delete-subdomain-panel"><p className="eyebrow"><span className="pixel-dot" /> DANGER ZONE</p><h2>Xóa {confirmationTarget}</h2><p>Thao tác này xóa toàn bộ DNS records, access key và dữ liệu đăng ký của subdomain. Tên sẽ trở lại trạng thái chưa đăng ký.</p><form onSubmit={deleteSubdomain}><label htmlFor="delete-confirm">Nhập chính xác <code>{confirmationTarget}</code><input id="delete-confirm" className="field" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" placeholder={confirmationTarget} required /></label><div className="editor-actions"><button className="button destructive" type="submit" disabled={state !== 'idle' || deleteConfirmation !== confirmationTarget}>{state === 'saving' ? 'Đang xóa...' : 'Tôi hiểu, xóa toàn bộ'}</button><button type="button" className="button cancel" onClick={() => { setDeletePanelOpen(false); setDeleteConfirmation(''); }}>Hủy</button></div></form></section>}
        <div className="manage-grid">
          <section className="panel record-editor"><div className="panel-heading"><span className="block-mark" /><div><p>{editingId ? (editingId === primaryRecord?.id ? 'EDIT PRIMARY RECORD' : 'EDIT RECORD') : 'NEW CHILD RECORD'}</p><h2>{editingId ? (editingId === primaryRecord?.id ? 'Sửa record chính' : 'Sửa DNS record') : 'Thêm record con'}</h2></div></div><form onSubmit={saveRecord}><div className="form-pair"><label>Type<select className="field" value={record.recordType} onChange={(event) => { const recordType = event.target.value as RecordType; setRecord((value) => ({ ...value, recordType, proxied: proxyable.has(recordType) ? value.proxied : false, priority: recordType === 'MX' ? value.priority : '' })); }}>{(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as RecordType[]).map((type) => <option value={type} key={type}>{type}</option>)}</select></label><label>Name<input className="field" value={record.recordName} onChange={(event) => setRecord((value) => ({ ...value, recordName: event.target.value }))} placeholder="@ hoặc web" required /></label></div><label>Content<input className="field" value={record.content} onChange={(event) => setRecord((value) => ({ ...value, content: event.target.value }))} placeholder={record.recordType === 'A' ? '203.0.113.10' : record.recordType === 'TXT' ? 'verification=value' : record.recordType === 'CAA' ? '0 issue letsencrypt.org' : 'target.example.com'} required /><small>{record.recordType === 'CAA' ? 'Ví dụ: 0 issue letsencrypt.org' : `Sẽ tạo tại ${recordHost(selected.label, record.recordName || '@')}`}</small></label><div className="form-pair"><label>TTL<select className="field" value={record.ttl} onChange={(event) => setRecord((value) => ({ ...value, ttl: Number(event.target.value) }))}><option value={1}>Auto</option><option value={60}>60 giây</option><option value={300}>5 phút</option><option value={3600}>1 giờ</option></select></label>{record.recordType === 'MX' && <label>Priority<input className="field" type="number" min="0" max="65535" value={record.priority} onChange={(event) => setRecord((value) => ({ ...value, priority: event.target.value }))} required /></label>}</div>{proxyable.has(record.recordType) && <label className="check-row proxy-row"><input type="checkbox" checked={record.proxied} onChange={(event) => setRecord((value) => ({ ...value, proxied: event.target.checked }))} /><span>Proxy qua Cloudflare <small>Chỉ bật cho web traffic HTTP/HTTPS.</small></span></label>}{message && <p className={`form-message ${positiveMessage ? 'success' : 'error'}`}>{message}</p>}<div className="editor-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang lưu...' : editingId ? 'Lưu thay đổi' : 'Tạo record'}</button>{editingId && <button type="button" className="button cancel" onClick={resetForm}>Hủy</button>}</div></form></section>
          <section className="panel records-panel"><div className="records-heading"><p className="eyebrow"><span className="pixel-dot" /> CHILD RECORDS</p><span className="status active">{secondaryRecords.length} records</span></div><div className="record-list">{secondaryRecords.length === 0 ? <p className="empty-copy">Chưa có record con nào.</p> : secondaryRecords.map((item) => <article className="record-row" key={item.id}><div className="record-main"><span className="record-type">{item.recordType}</span><div><strong>{recordHost(selected.label, item.recordName)}</strong><code>{item.content}{item.priority !== null ? ` · priority ${item.priority}` : ''}</code><small>{ttlLabel(item.ttl)}{item.proxied ? ' · proxied' : ' · DNS only'}</small></div></div><div className="record-actions"><button type="button" className="record-action" onClick={() => editRecord(item)}>Sửa</button><button type="button" className="record-action danger-action" onClick={() => void deleteRecord(item)} disabled={state !== 'idle'}>Xóa</button></div></article>)}</div></section>
        </div>
      </>}
    </>}
  </div></main>;
}
