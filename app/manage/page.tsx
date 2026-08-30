'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA';
type DnsRecord = {
  id: string;
  recordType: RecordType;
  recordName: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
};
type ManagedSubdomain = { id: string; label: string; status: string; records: DnsRecord[] };
type SessionData = { owner: { email: string; githubHandle: string | null }; subdomains: Array<{ id: string; label: string; status: string }> };

const emptyRecord = { recordType: 'A' as RecordType, recordName: '@', content: '', ttl: 1, proxied: false, priority: '' };
const proxyable = new Set<RecordType>(['A', 'AAAA', 'CNAME']);

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
  const [record, setRecord] = useState(emptyRecord);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [message, setMessage] = useState('');

  const selected = useMemo(() => subdomains.find((item) => item.id === selectedId) ?? subdomains[0] ?? null, [selectedId, subdomains]);

  async function loadPanel() {
    try {
      const sessionResponse = await fetch('/api/manage/session');
      if (!sessionResponse.ok) {
        setSession(null);
        setSubdomains([]);
        setState('idle');
        return;
      }
      const sessionPayload = await sessionResponse.json() as SessionData;
      const recordsResponse = await fetch('/api/manage/records');
      const recordsPayload = await recordsResponse.json() as { subdomains?: ManagedSubdomain[]; error?: string };
      if (!recordsResponse.ok || !recordsPayload.subdomains) {
        setMessage(recordsPayload.error ?? 'Không thể tải DNS records.');
        setState('idle');
        return;
      }
      setSession(sessionPayload);
      setSubdomains(recordsPayload.subdomains);
      setSelectedId((current) => current || recordsPayload.subdomains?.[0]?.id || '');
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
    setRecord(emptyRecord);
    setEditingId(null);
  }

  function editRecord(item: DnsRecord) {
    setEditingId(item.id);
    setRecord({ recordType: item.recordType, recordName: item.recordName, content: item.content, ttl: item.ttl, proxied: item.proxied, priority: item.priority?.toString() ?? '' });
    setMessage('Đang sửa record đã chọn.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveRecord(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setState('saving');
    setMessage('');
    const body = { ...record, subdomainId: selected.id, priority: record.priority === '' ? null : Number(record.priority) };
    const response = await fetch('/api/manage/records', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingId ? { ...body, id: editingId } : body),
    });
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
    if (!window.confirm(`Xóa ${item.recordType} ${item.recordName} khỏi ${selected?.label}.takeshi.dev?`)) return;
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

  async function logout() {
    await fetch('/api/manage/session', { method: 'DELETE' });
    setSession(null);
    setSubdomains([]);
    setSelectedId('');
    resetForm();
  }

  if (!session) {
    return (
      <main className="manage-page">
        <div className="manage-shell narrow-shell">
          <Link href="/" className="back-link">← Về trang đăng ký</Link>
          <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>Nhập access key mà admin gửi riêng cho bạn. Key chỉ tạo phiên trên thiết bị này.</p></div>
          <form className="panel access-form" onSubmit={login}>
            <label htmlFor="owner-key">Owner access key<input id="owner-key" className="field" type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="off" required /></label>
            {message && <p className="form-message error">{message}</p>}
            <button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang mở...' : 'Mở DNS panel'}</button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="manage-page">
      <div className="manage-shell">
        <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><button className="text-button" type="button" onClick={logout}>Đăng xuất</button></header>
        <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>{session.owner.email}<br />Chỉ các record thuộc subdomain của bạn mới hiển thị ở đây.</p></div>

        {subdomains.length === 0 ? <div className="panel empty-state">Chưa có subdomain active cho access key này.</div> : <>
          <div className="domain-tabs" role="tablist">
            {subdomains.map((domain) => <button type="button" key={domain.id} className={domain.id === selected?.id ? 'domain-tab active' : 'domain-tab'} onClick={() => { setSelectedId(domain.id); resetForm(); }}>{domain.label}.takeshi.dev</button>)}
          </div>
          {selected && <div className="manage-grid">
            <section className="panel record-editor">
              <div className="panel-heading"><span className="block-mark" /><div><p>{editingId ? 'EDIT RECORD' : 'NEW RECORD'}</p><h2>{editingId ? 'Sửa DNS record' : 'Thêm DNS record'}</h2></div></div>
              <form onSubmit={saveRecord}>
                <div className="form-pair"><label>Type<select className="field" value={record.recordType} onChange={(event) => { const recordType = event.target.value as RecordType; setRecord((value) => ({ ...value, recordType, proxied: proxyable.has(recordType) ? value.proxied : false, priority: recordType === 'MX' ? value.priority : '' })); }}>
                  {(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as RecordType[]).map((type) => <option value={type} key={type}>{type}</option>)}
                </select></label><label>Name<input className="field" value={record.recordName} onChange={(event) => setRecord((value) => ({ ...value, recordName: event.target.value }))} placeholder="@ hoặc www" required /></label></div>
                <label>Content<input className="field" value={record.content} onChange={(event) => setRecord((value) => ({ ...value, content: event.target.value }))} placeholder={record.recordType === 'A' ? '203.0.113.10' : record.recordType === 'TXT' ? 'verification=value' : record.recordType === 'CAA' ? '0 issue letsencrypt.org' : 'target.example.com'} required /><small>{record.recordType === 'CAA' ? 'Ví dụ: 0 issue letsencrypt.org' : `Sẽ tạo tại ${recordHost(selected.label, record.recordName || '@')}`}</small></label>
                <div className="form-pair"><label>TTL<select className="field" value={record.ttl} onChange={(event) => setRecord((value) => ({ ...value, ttl: Number(event.target.value) }))}><option value={1}>Auto</option><option value={60}>60 giây</option><option value={300}>5 phút</option><option value={3600}>1 giờ</option></select></label>{record.recordType === 'MX' && <label>Priority<input className="field" type="number" min="0" max="65535" value={record.priority} onChange={(event) => setRecord((value) => ({ ...value, priority: event.target.value }))} required /></label>}</div>
                {proxyable.has(record.recordType) && <label className="check-row proxy-row"><input type="checkbox" checked={record.proxied} onChange={(event) => setRecord((value) => ({ ...value, proxied: event.target.checked }))} /><span>Proxy qua Cloudflare <small>Chỉ bật cho web traffic HTTP/HTTPS.</small></span></label>}
                {message && <p className={`form-message ${message.includes('đã') || message.includes('Đang') ? 'success' : 'error'}`}>{message}</p>}
                <div className="editor-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? 'Đang lưu...' : editingId ? 'Lưu thay đổi' : 'Tạo record'}</button>{editingId && <button type="button" className="button cancel" onClick={resetForm}>Hủy</button>}</div>
              </form>
            </section>
            <section className="panel records-panel"><div className="records-heading"><div><p className="eyebrow"><span className="pixel-dot" /> LIVE DNS</p><h2>{selected.label}.takeshi.dev</h2></div><span className="status active">{selected.records.length} records</span></div>
              <div className="record-list">{selected.records.length === 0 ? <p className="empty-copy">Chưa có record nào.</p> : selected.records.map((item) => <article className="record-row" key={item.id}><div className="record-main"><span className="record-type">{item.recordType}</span><div><strong>{recordHost(selected.label, item.recordName)}</strong><code>{item.content}{item.priority !== null ? ` · priority ${item.priority}` : ''}</code><small>{ttlLabel(item.ttl)}{item.proxied ? ' · proxied' : ' · DNS only'}</small></div></div><div className="record-actions"><button type="button" className="record-action" onClick={() => editRecord(item)}>Sửa</button><button type="button" className="record-action danger-action" onClick={() => void deleteRecord(item)} disabled={state !== 'idle'}>Xóa</button></div></article>)}</div>
            </section>
          </div>}
        </>}
      </div>
    </main>
  );
}
