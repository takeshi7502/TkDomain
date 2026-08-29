'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';

type RequestRecord = {
  id: string;
  subdomain: string;
  cnameTarget: string;
  githubHandle: string | null;
  email: string;
  status: 'pending' | 'active' | 'rejected';
  createdAt: number;
  reviewerNote: string | null;
};

type AdminState = 'idle' | 'loading' | 'ready' | 'error';

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export default function AdminPage() {
  const [key, setKey] = useState('');
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [state, setState] = useState<AdminState>('idle');
  const [message, setMessage] = useState('');
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function loadRequests(event?: FormEvent) {
    event?.preventDefault();
    setState('loading');
    setMessage('');
    try {
      const response = await fetch('/api/admin/requests', { headers: { 'x-registry-admin-key': key } });
      const payload = await response.json() as { error?: string; requests?: RequestRecord[] };
      if (!response.ok || !payload.requests) throw new Error(payload.error ?? 'Không thể tải request.');
      setRequests(payload.requests);
      setState('ready');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Không thể tải request.');
    }
  }

  async function review(id: string, action: 'provision' | 'reject') {
    const actionLabel = action === 'provision' ? 'duyệt và tạo DNS' : 'từ chối';
    if (!window.confirm(`Bạn muốn ${actionLabel} request này?`)) return;
    setActingOn(id);
    setMessage('');
    try {
      const response = await fetch('/api/admin/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-registry-admin-key': key },
        body: JSON.stringify({ id, action }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể cập nhật request.');
      await loadRequests();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể cập nhật request.');
    } finally {
      setActingOn(null);
    }
  }

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <Link href="/" className="back-link">← Về trang đăng ký</Link>
        <div className="admin-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER AREA</p><h1>Requests</h1></div><p>Khóa quản trị chỉ được giữ trong tab này và không được lưu lại. Chỉ dùng trang này trên thiết bị của bạn.</p></div>
        <form className="panel admin-key-form" onSubmit={loadRequests}>
          <label htmlFor="admin-key">Registry admin key<input id="admin-key" className="field" type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" required /></label>
          <button type="submit" className="button" disabled={state === 'loading'}>{state === 'loading' ? 'Đang tải...' : 'Mở requests'}</button>
        </form>
        {message && <p className="form-message error admin-message" role="alert">{message}</p>}
        {state === 'ready' && (requests.length === 0 ? <div className="panel empty-state">Chưa có request nào.</div> : <div className="request-list">{requests.map((request) => <article className="panel request-card" key={request.id}><div className="request-card-head"><div><h2>{request.subdomain}<span>.takeshi.dev</span></h2><p className="note">Gửi lúc {formatDate(request.createdAt)}</p></div><span className={`status ${request.status}`}>{request.status}</span></div><div className="request-details"><div>CNAME<strong>{request.cnameTarget}</strong></div><div>Email<strong>{request.email}</strong></div><div>GitHub<strong>{request.githubHandle || '—'}</strong></div></div>{request.reviewerNote && <p className="note">Ghi chú: {request.reviewerNote}</p>}{request.status === 'pending' && <div className="request-card-actions"><button type="button" className="button" onClick={() => review(request.id, 'provision')} disabled={actingOn === request.id}>{actingOn === request.id ? 'Đang xử lý...' : 'Duyệt + tạo DNS'}</button><button type="button" className="button reject" onClick={() => review(request.id, 'reject')} disabled={actingOn === request.id}>Từ chối</button></div>}</article>)}</div>)}
      </div>
    </main>
  );
}
