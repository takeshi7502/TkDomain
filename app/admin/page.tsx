'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';

type RequestRecord = {
  id: string;
  subdomain: string;
  cnameTarget: string;
  telegramUsername: string | null;
  status: 'pending' | 'active' | 'rejected';
  createdAt: number;
  reviewerNote: string | null;
};

type AdminState = 'idle' | 'loading';
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export default function AdminPage() {
  const [key, setKey] = useState('');
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [state, setState] = useState<AdminState>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [accessKey, setAccessKey] = useState<{ subdomain: string; value: string } | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function loadRequests(event?: FormEvent, clearMessage = true) {
    event?.preventDefault();
    setState('loading');
    if (clearMessage) setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', { headers: { 'x-registry-admin-key': key } });
      const payload = await response.json() as { error?: string; requests?: RequestRecord[] };
      if (!response.ok || !payload.requests) throw new Error(payload.error ?? 'Không thể tải request.');
      setRequests(payload.requests);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải request.' });
    } finally {
      setState('idle');
    }
  }

  async function review(id: string, action: 'provision' | 'reject' | 'reset_access') {
    const label = action === 'provision' ? 'duyệt và tạo DNS' : action === 'reject' ? 'từ chối' : 'tạo access key mới';
    if (!window.confirm(`Bạn muốn ${label} request này?`)) return;
    setActingOn(id);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-registry-admin-key': key },
        body: JSON.stringify({ id, action }),
      });
      const payload = await response.json() as { error?: string; ownerAccessKey?: string; accessKeyProvided?: boolean; subdomain?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể cập nhật request.');
      if (payload.ownerAccessKey && payload.subdomain) {
        setAccessKey({ subdomain: payload.subdomain, value: payload.ownerAccessKey });
        setNotice({ tone: 'success', text: 'DNS đã sẵn sàng. Gửi access key dưới đây riêng cho chủ subdomain.' });
      } else {
        setNotice({ tone: 'success', text: action === 'reject' ? 'Đã từ chối request.' : payload.accessKeyProvided ? 'DNS đã sẵn sàng. Chủ subdomain sẽ dùng access key đã tự đặt khi đăng ký.' : 'Đã cập nhật request.' });
      }
      await loadRequests(undefined, false);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cập nhật request.' });
    } finally {
      setActingOn(null);
    }
  }

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <Link href="/" className="back-link">← Về trang đăng ký</Link>
        <div className="admin-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER AREA</p><h1>Requests</h1></div><p>Khóa quản trị chỉ được giữ trong tab này và không được lưu lại. Access key chỉ hiện một lần sau khi tạo/reset.</p></div>
        <form className="panel admin-key-form" onSubmit={loadRequests}>
          <label htmlFor="admin-key">Registry admin key<input id="admin-key" className="field" type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" required /></label>
          <button type="submit" className="button" disabled={state === 'loading'}>{state === 'loading' ? 'Đang tải...' : 'Mở requests'}</button>
        </form>
        {notice && <p className={`form-message ${notice.tone} admin-message`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        {accessKey && <section className="panel owner-key-panel"><p className="eyebrow"><span className="pixel-dot" /> OWNER ACCESS KEY</p><h2>{accessKey.subdomain}</h2><code>{accessKey.value}</code><p className="note">Gửi key này qua kênh riêng. Tạo key mới sẽ hủy các phiên panel cũ.</p><button type="button" className="text-button" onClick={() => setAccessKey(null)}>Đã sao chép</button></section>}
        {requests.length === 0 ? <div className="panel empty-state">Nhập admin key để tải requests.</div> : <div className="request-list">{requests.map((request) => <article className="panel request-card" key={request.id}><div className="request-card-head"><div><h2>{request.subdomain}<span>.takeshi.dev</span></h2><p className="note">Gửi lúc {formatDate(request.createdAt)}</p></div><span className={`status ${request.status}`}>{request.status}</span></div><div className="request-details"><div>CNAME<strong>{request.cnameTarget}</strong></div><div>Telegram<strong>{request.telegramUsername ? `@${request.telegramUsername}` : 'Legacy request'}</strong></div></div>{request.reviewerNote && <p className="note">Ghi chú: {request.reviewerNote}</p>}{request.status === 'pending' && <div className="request-card-actions"><button type="button" className="button" onClick={() => review(request.id, 'provision')} disabled={actingOn === request.id}>{actingOn === request.id ? 'Đang xử lý...' : 'Duyệt + tạo DNS'}</button><button type="button" className="button reject" onClick={() => review(request.id, 'reject')} disabled={actingOn === request.id}>Từ chối</button></div>}{request.status === 'active' && <div className="request-card-actions"><button type="button" className="button secondary-action" onClick={() => review(request.id, 'reset_access')} disabled={actingOn === request.id}>{actingOn === request.id ? 'Đang tạo...' : 'Tạo access key'}</button></div>}</article>)}</div>}
      </div>
    </main>
  );
}
