'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';

type RequestStatus = 'pending' | 'active' | 'rejected' | 'cancelled' | 'released';
type DashboardTab = 'active-subdomains' | 'pending-requests' | 'request-log' | 'dns-log';

type RequestRecord = {
  id: string;
  subdomain: string;
  cnameTarget: string;
  telegramUsername: string | null;
  status: RequestStatus;
  createdAt: number;
  reviewedAt: number | null;
  cancelledAt: number | null;
  releasedAt: number | null;
  reviewerNote: string | null;
};

type ActiveSubdomain = {
  id: string;
  requestId: string | null;
  label: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  telegramUsername: string | null;
  recordCount: number;
};

type DnsEvent = {
  id: string;
  subdomainId: string | null;
  domainLabel: string | null;
  currentDomainLabel: string | null;
  recordId: string | null;
  actorType: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: number;
};

type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;
type AdminState = 'idle' | 'loading';

const tabs: Array<{ id: DashboardTab; label: string }> = [
  { id: 'active-subdomains', label: 'Subdomain đang dùng' },
  { id: 'pending-requests', label: 'Chờ duyệt' },
  { id: 'request-log', label: 'Nhật ký yêu cầu' },
  { id: 'dns-log', label: 'Nhật ký DNS' },
];

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function requestStatusLabel(status: RequestStatus) {
  const labels: Record<RequestStatus, string> = {
    pending: 'Chờ duyệt',
    active: 'Đang dùng',
    rejected: 'Đã từ chối',
    cancelled: 'Người dùng đã hủy',
    released: 'Đã trả lại',
  };
  return labels[status];
}

function requestUpdatedAt(request: RequestRecord) {
  return request.cancelledAt ?? request.releasedAt ?? request.reviewedAt;
}

function dnsActionLabel(action: string) {
  const labels: Record<string, string> = {
    record_created: 'Tạo DNS record',
    record_updated: 'Cập nhật DNS record',
    record_deleted: 'Xóa DNS record',
    primary_record_created: 'Tạo record chính',
    primary_record_updated: 'Cập nhật record chính',
    primary_record_deleted: 'Xóa record chính',
    child_record_created: 'Thêm record con',
    child_record_updated: 'Sửa record con',
    child_record_deleted: 'Xóa record con',
    owner_key_reset: 'Tạo access key mới',
    subdomain_created: 'Tạo subdomain',
    subdomain_deleted: 'Xóa subdomain',
    subdomain_released: 'Trả lại subdomain',
    request_approved: 'Duyệt yêu cầu',
    request_rejected: 'Từ chối yêu cầu',
  };
  return labels[action] ?? action.replace(/_/g, ' ');
}

function actorLabel(actorType: string) {
  const labels: Record<string, string> = { admin: 'Admin', owner: 'Chủ subdomain', system: 'Hệ thống' };
  return labels[actorType] ?? actorType;
}

function eventDetailsLabel(details: Record<string, unknown> | null | undefined) {
  if (!details || typeof details !== 'object') return 'Không có chi tiết bổ sung.';
  const entries = Object.entries(details);
  if (entries.length === 0) return 'Không có chi tiết bổ sung.';
  const labels: Record<string, string> = { type: 'Loại', name: 'Tên', content: 'Giá trị', contentChanged: 'Đổi giá trị', reason: 'Lý do' };
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${labels[key] ?? key}: ${typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`)
    .join(' · ');
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const className = status === 'active' ? 'status active' : status === 'pending' ? 'status pending' : status === 'rejected' || status === 'cancelled' || status === 'released' ? 'status rejected' : 'status';
  return <span className={className}>{label}</span>;
}

export default function AdminPage() {
  const [key, setKey] = useState('');
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [activeSubdomains, setActiveSubdomains] = useState<ActiveSubdomain[]>([]);
  const [dnsEvents, setDnsEvents] = useState<DnsEvent[]>([]);
  const [activeTab, setActiveTab] = useState<DashboardTab>('active-subdomains');
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [state, setState] = useState<AdminState>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [accessKey, setAccessKey] = useState<{ subdomain: string; value: string } | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const pendingRequests = requests.filter((request) => request.status === 'pending');

  async function loadRequests(event?: FormEvent, clearNotice = true) {
    event?.preventDefault();
    setState('loading');
    if (clearNotice) setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', { headers: { 'x-registry-admin-key': key } });
      const payload = await response.json() as { error?: string; requests?: RequestRecord[]; activeSubdomains?: ActiveSubdomain[]; dnsEvents?: DnsEvent[] };
      if (!response.ok || !Array.isArray(payload.requests)) throw new Error(payload.error ?? 'Không thể tải dữ liệu quản trị.');
      setRequests(payload.requests);
      setActiveSubdomains(Array.isArray(payload.activeSubdomains) ? payload.activeSubdomains : []);
      setDnsEvents(Array.isArray(payload.dnsEvents) ? payload.dnsEvents : []);
      setDashboardLoaded(true);
    } catch (error) {
      setDashboardLoaded(false);
      setRequests([]);
      setActiveSubdomains([]);
      setDnsEvents([]);
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải dữ liệu quản trị.' });
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
        setNotice({
          tone: 'success',
          text: action === 'reject'
            ? 'Đã từ chối request.'
            : payload.accessKeyProvided
              ? 'DNS đã sẵn sàng. Chủ subdomain sẽ dùng access key đã tự đặt khi đăng ký.'
              : 'Đã cập nhật request.',
        });
      }
      await loadRequests(undefined, false);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cập nhật request.' });
    } finally {
      setActingOn(null);
    }
  }

  function renderRequestCard(request: RequestRecord, showActions = false) {
    return <article className="panel request-card" key={request.id}>
      <div className="request-card-head">
        <div>
          <h2>{request.subdomain}<span>.takeshi.dev</span></h2>
          <p className="note">Gửi lúc {formatDate(request.createdAt)}</p>
          {requestUpdatedAt(request) && <p className="note">Cập nhật {formatDate(requestUpdatedAt(request)!)}</p>}
        </div>
        <StatusBadge status={request.status} label={requestStatusLabel(request.status)} />
      </div>
      <div className="request-details">
        <div>CNAME<strong>{request.cnameTarget}</strong></div>
        <div>Telegram<strong>{request.telegramUsername ? `@${request.telegramUsername}` : 'Yêu cầu cũ'}</strong></div>
      </div>
      {request.reviewerNote && <p className="note">Ghi chú: {request.reviewerNote}</p>}
      {showActions && <div className="request-card-actions">
        <button type="button" className="button" onClick={() => review(request.id, 'provision')} disabled={actingOn === request.id}>{actingOn === request.id ? 'Đang xử lý...' : 'Duyệt + tạo DNS'}</button>
        <button type="button" className="button reject" onClick={() => review(request.id, 'reject')} disabled={actingOn === request.id}>Từ chối</button>
      </div>}
      {!showActions && request.status === 'active' && <div className="request-card-actions">
        <button type="button" className="button secondary-action" onClick={() => review(request.id, 'reset_access')} disabled={actingOn === request.id}>{actingOn === request.id ? 'Đang tạo...' : 'Tạo access key mới'}</button>
      </div>}
    </article>;
  }

  function renderDashboard() {
    if (!dashboardLoaded) return <div className="panel empty-state">Nhập admin key để tải dashboard.</div>;

    if (activeTab === 'active-subdomains') {
      return activeSubdomains.length === 0
        ? <div className="panel empty-state">Chưa có subdomain nào đang hoạt động.</div>
        : <div className="request-list">{activeSubdomains.map((domain) => <article className="panel request-card" key={domain.id}>
          <div className="request-card-head">
            <div>
              <h2>{domain.label}<span>.takeshi.dev</span></h2>
              <p className="note">Tạo lúc {formatDate(domain.createdAt)}</p>
            </div>
            <StatusBadge status={domain.status} label={domain.status === 'active' ? 'Đang dùng' : domain.status} />
          </div>
          <div className="request-details">
            <div>Telegram<strong>{domain.telegramUsername ? `@${domain.telegramUsername}` : 'Không có dữ liệu'}</strong></div>
            <div>DNS records<strong>{domain.recordCount}</strong></div>
            <div>Cập nhật<strong>{formatDate(domain.updatedAt)}</strong></div>
          </div>
          {domain.requestId && <div className="request-card-actions"><button type="button" className="button secondary-action" onClick={() => review(domain.requestId!, 'reset_access')} disabled={actingOn === domain.requestId}>{actingOn === domain.requestId ? 'Đang tạo...' : 'Tạo access key mới'}</button></div>}
        </article>)}</div>;
    }

    if (activeTab === 'pending-requests') {
      return pendingRequests.length === 0
        ? <div className="panel empty-state">Không có yêu cầu nào đang chờ duyệt.</div>
        : <div className="request-list">{pendingRequests.map((request) => renderRequestCard(request, true))}</div>;
    }

    if (activeTab === 'request-log') {
      return requests.length === 0
        ? <div className="panel empty-state">Chưa có nhật ký yêu cầu.</div>
        : <div className="request-list">{requests.map((request) => renderRequestCard(request))}</div>;
    }

    return dnsEvents.length === 0
      ? <div className="panel empty-state">Chưa có sự kiện DNS nào.</div>
      : <div className="request-list">{dnsEvents.map((event) => <article className="panel request-card" key={event.id}>
        <div className="request-card-head">
          <div>
            <h2>{event.domainLabel ?? event.currentDomainLabel ?? 'Subdomain đã xóa'}<span>.takeshi.dev</span></h2>
            <p className="note">{formatDate(event.createdAt)}</p>
          </div>
          <StatusBadge status="active" label={actorLabel(event.actorType)} />
        </div>
        <div className="request-details">
          <div>Thao tác<strong>{dnsActionLabel(event.action)}</strong></div>
          <div>Chi tiết<strong>{eventDetailsLabel(event.details)}</strong></div>
        </div>
      </article>)}</div>;
  }

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <Link href="/" className="back-link">← Về trang đăng ký</Link>
        <div className="admin-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER AREA</p><h1>Requests</h1></div><p>Khóa quản trị chỉ được giữ trong tab này và không được lưu lại. Access key chỉ hiện một lần sau khi tạo/reset.</p></div>
        <form className="panel admin-key-form" onSubmit={loadRequests}>
          <label htmlFor="admin-key">Registry admin key<input id="admin-key" className="field" type="password" value={key} onChange={(event) => { setKey(event.target.value); setDashboardLoaded(false); }} autoComplete="off" required /></label>
          <button type="submit" className="button" disabled={state === 'loading'}>{state === 'loading' ? 'Đang tải...' : 'Mở dashboard'}</button>
        </form>
        {notice && <p className={`form-message ${notice.tone} admin-message`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        {accessKey && <section className="panel owner-key-panel"><p className="eyebrow"><span className="pixel-dot" /> OWNER ACCESS KEY</p><h2>{accessKey.subdomain}</h2><code>{accessKey.value}</code><p className="note">Gửi key này qua kênh riêng. Tạo key mới sẽ hủy các phiên panel cũ.</p><button type="button" className="text-button" onClick={() => setAccessKey(null)}>Đã sao chép</button></section>}
        {dashboardLoaded && <nav className="admin-tabs" role="tablist" aria-label="Dashboard quản trị">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'button' : 'button secondary-action'} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === 'pending-requests' && pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}</button>)}</nav>}
        <section className="admin-tab-panel" role="tabpanel">{renderDashboard()}</section>
      </div>
    </main>
  );
}
