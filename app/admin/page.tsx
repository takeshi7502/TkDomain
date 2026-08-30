'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
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
type DashboardPayload = { error?: string; requests?: RequestRecord[]; activeSubdomains?: ActiveSubdomain[]; dnsEvents?: DnsEvent[] };

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
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [activeSubdomains, setActiveSubdomains] = useState<ActiveSubdomain[]>([]);
  const [dnsEvents, setDnsEvents] = useState<DnsEvent[]>([]);
  const [activeTab, setActiveTab] = useState<DashboardTab>('active-subdomains');
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [state, setState] = useState<AdminState>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [accessKey, setAccessKey] = useState<{ subdomain: string; value: string } | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const polling = useRef(false);
  const actingOnRef = useRef<string | null>(null);
  const stateRef = useRef<AdminState>('idle');
  const authenticatedRef = useRef(false);

  const setAdminAuthenticated = useCallback((value: boolean) => {
    authenticatedRef.current = value;
    setAuthenticated(value);
  }, []);

  const pendingRequests = requests.filter((request) => request.status === 'pending');

  const loadDashboard = useCallback(async ({ clearNotice = true, silent = false }: { clearNotice?: boolean; silent?: boolean } = {}) => {
    if (!silent) {
      stateRef.current = 'loading';
      setState('loading');
    }
    if (clearNotice) setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', { cache: 'no-store' });
      const payload = await response.json() as DashboardPayload;
      if (!response.ok || !Array.isArray(payload.requests)) {
        if (response.status === 401) {
          setAdminAuthenticated(false);
          setDashboardLoaded(false);
          setRequests([]);
          setActiveSubdomains([]);
          setDnsEvents([]);
        }
        throw new Error(payload.error ?? 'Không thể tải dữ liệu quản trị.');
      }
      if (silent && !authenticatedRef.current) return;
      setRequests(payload.requests);
      setActiveSubdomains(Array.isArray(payload.activeSubdomains) ? payload.activeSubdomains : []);
      setDnsEvents(Array.isArray(payload.dnsEvents) ? payload.dnsEvents : []);
      setDashboardLoaded(true);
    } catch (error) {
      if (!silent) {
        setDashboardLoaded(false);
        setRequests([]);
        setActiveSubdomains([]);
        setDnsEvents([]);
        setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải dữ liệu quản trị.' });
      }
    } finally {
      if (!silent) {
        stateRef.current = 'idle';
        setState('idle');
      }
    }
  }, [setAdminAuthenticated]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const response = await fetch('/api/admin/session', { cache: 'no-store' });
        if (!response.ok || !mounted) return;
        setAdminAuthenticated(true);
        await loadDashboard({ clearNotice: false });
      } catch {
        if (mounted) setNotice({ tone: 'error', text: 'Không thể khôi phục phiên admin. Hãy thử lại.' });
      } finally {
        if (mounted) setSessionChecked(true);
      }
    })();
    return () => { mounted = false; };
  }, [loadDashboard, setAdminAuthenticated]);

  useEffect(() => {
    if (!authenticated) return;
    const poll = () => {
      if (document.visibilityState !== 'visible' || polling.current || actingOnRef.current || stateRef.current !== 'idle') return;
      polling.current = true;
      void loadDashboard({ clearNotice: false, silent: true }).finally(() => { polling.current = false; });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    window.addEventListener('visibilitychange', refreshWhenVisible);
    const interval = window.setInterval(poll, 15_000);
    return () => {
      window.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [authenticated, loadDashboard]);

  async function startSession(event: FormEvent) {
    event.preventDefault();
    stateRef.current = 'loading';
    setState('loading');
    setNotice(null);
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: key }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể mở dashboard quản trị.');
      setKey('');
      setAdminAuthenticated(true);
      await loadDashboard({ clearNotice: false });
    } catch (error) {
      stateRef.current = 'idle';
      setState('idle');
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể mở dashboard quản trị.' });
    }
  }

  async function logout() {
    stateRef.current = 'loading';
    setState('loading');
    try {
      const response = await fetch('/api/admin/session', { method: 'DELETE' });
      if (!response.ok) throw new Error('Không thể đăng xuất phiên admin.');
      setAdminAuthenticated(false);
      setDashboardLoaded(false);
      setRequests([]);
      setActiveSubdomains([]);
      setDnsEvents([]);
      setAccessKey(null);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể đăng xuất phiên admin.' });
    } finally {
      stateRef.current = 'idle';
      setState('idle');
    }
  }

  async function review(id: string, action: 'provision' | 'reject' | 'reset_access') {
    const label = action === 'provision' ? 'duyệt và tạo DNS' : action === 'reject' ? 'từ chối' : 'tạo access key mới';
    if (!window.confirm(`Bạn muốn ${label} request này?`)) return;
    actingOnRef.current = id;
    setActingOn(id);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
      await loadDashboard({ clearNotice: false });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cập nhật request.' });
    } finally {
      actingOnRef.current = null;
      setActingOn(null);
    }
  }

  function renderAdminAction(
    id: string,
    action: 'provision' | 'reject' | 'reset_access',
    label: string,
    symbol: string,
    danger = false,
  ) {
    const busy = actingOn === id;
    return <button
      type="button"
      className={`admin-icon-action${danger ? ' danger' : ''}`}
      onClick={() => review(id, action)}
      disabled={busy}
      title={busy ? 'Đang xử lý' : label}
      aria-label={busy ? 'Đang xử lý' : label}
    >{busy ? '…' : symbol}</button>;
  }

  function renderRequestRow(request: RequestRecord, showActions = false) {
    const updatedAt = requestUpdatedAt(request);
    return <article className="panel admin-list-row" key={request.id}>
      <div className="admin-row-main">
        <h2 className="admin-row-title">{request.subdomain}<span>.takeshi.dev</span></h2>
        <div className="admin-row-meta">
          <span title={`CNAME: ${request.cnameTarget}`}><b>CNAME</b>{request.cnameTarget}</span>
          <span><b>Telegram</b>{request.telegramUsername ? `@${request.telegramUsername}` : 'Yêu cầu cũ'}</span>
          <span><b>Gửi</b>{formatDate(request.createdAt)}</span>
          {updatedAt && <span><b>Cập nhật</b>{formatDate(updatedAt)}</span>}
        </div>
        {request.reviewerNote && <p className="admin-row-note" title={request.reviewerNote}>Ghi chú: {request.reviewerNote}</p>}
      </div>
      <div className="admin-row-side">
        <StatusBadge status={request.status} label={requestStatusLabel(request.status)} />
        {showActions && <div className="admin-row-actions">
          {renderAdminAction(request.id, 'provision', 'Duyệt và tạo DNS', '✓')}
          {renderAdminAction(request.id, 'reject', 'Từ chối yêu cầu', '×', true)}
        </div>}
        {!showActions && request.status === 'active' && <div className="admin-row-actions">
          {renderAdminAction(request.id, 'reset_access', 'Tạo access key mới', '↻')}
        </div>}
      </div>
    </article>;
  }

  function renderDashboard() {
    if (!dashboardLoaded) return <div className="panel empty-state">{sessionChecked ? 'Nhập admin key để tải dashboard.' : 'Đang khôi phục phiên admin...'}</div>;

    if (activeTab === 'active-subdomains') {
      return activeSubdomains.length === 0
        ? <div className="panel empty-state">Chưa có subdomain nào đang hoạt động.</div>
        : <div className="request-list">{activeSubdomains.map((domain) => <article className="panel admin-list-row" key={domain.id}>
          <div className="admin-row-main">
            <h2 className="admin-row-title">{domain.label}<span>.takeshi.dev</span></h2>
            <div className="admin-row-meta">
              <span><b>Telegram</b>{domain.telegramUsername ? `@${domain.telegramUsername}` : 'Không có dữ liệu'}</span>
              <span><b>Records con</b>{domain.recordCount}</span>
              <span><b>Cập nhật</b>{formatDate(domain.updatedAt)}</span>
            </div>
          </div>
          <div className="admin-row-side">
            <StatusBadge status={domain.status} label={domain.status === 'active' ? 'Đang dùng' : domain.status} />
            {domain.requestId && <div className="admin-row-actions">{renderAdminAction(domain.requestId, 'reset_access', `Tạo access key mới cho ${domain.label}.takeshi.dev`, '↻')}</div>}
          </div>
        </article>)}</div>;
    }

    if (activeTab === 'pending-requests') {
      return pendingRequests.length === 0
        ? <div className="panel empty-state">Không có yêu cầu nào đang chờ duyệt.</div>
        : <div className="request-list">{pendingRequests.map((request) => renderRequestRow(request, true))}</div>;
    }

    if (activeTab === 'request-log') {
      return requests.length === 0
        ? <div className="panel empty-state">Chưa có nhật ký yêu cầu.</div>
        : <div className="request-list">{requests.map((request) => renderRequestRow(request))}</div>;
    }

    return dnsEvents.length === 0
      ? <div className="panel empty-state">Chưa có sự kiện DNS nào.</div>
      : <div className="request-list">{dnsEvents.map((event) => {
        const domainLabel = event.domainLabel ?? event.currentDomainLabel;
        const details = eventDetailsLabel(event.details);
        return <article className="panel admin-list-row" key={event.id}>
          <div className="admin-row-main">
            <h2 className="admin-row-title">{domainLabel ? <>{domainLabel}<span>.takeshi.dev</span></> : 'Subdomain đã xóa'}</h2>
            <div className="admin-row-meta">
              <span><b>Thao tác</b>{dnsActionLabel(event.action)}</span>
              <span><b>Lúc</b>{formatDate(event.createdAt)}</span>
              <span className="admin-event-detail" title={details}><b>Chi tiết</b>{details}</span>
            </div>
          </div>
          <div className="admin-row-side"><StatusBadge status="active" label={actorLabel(event.actorType)} /></div>
        </article>;
      })}</div>;
  }

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <Link href="/" className="back-link">← Về trang đăng ký</Link>
        <div className="admin-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER AREA</p><h1>Requests</h1></div><div><p>{authenticated ? 'Phiên admin được giữ bằng cookie HTTP-only trên thiết bị này. Admin key không được lưu trong trình duyệt.' : 'Nhập admin key để tạo phiên an toàn trên thiết bị này. Key không được lưu trong trình duyệt.'}</p>{authenticated && <button type="button" className="text-button" onClick={() => void logout()} disabled={state === 'loading'}>Đăng xuất admin</button>}</div></div>
        {!authenticated && sessionChecked && <form className="panel admin-key-form" onSubmit={startSession}>
          <label htmlFor="admin-key">Registry admin key<input id="admin-key" className="field" type="password" value={key} onChange={(event) => { setKey(event.target.value); setDashboardLoaded(false); }} autoComplete="off" required /></label>
          <button type="submit" className="button" disabled={state === 'loading'}>{state === 'loading' ? 'Đang mở...' : 'Mở dashboard'}</button>
        </form>}
        {notice && <p className={`form-message ${notice.tone} admin-message`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        {authenticated && accessKey && <section className="panel owner-key-panel"><p className="eyebrow"><span className="pixel-dot" /> OWNER ACCESS KEY</p><h2>{accessKey.subdomain}</h2><code>{accessKey.value}</code><p className="note">Gửi key này qua kênh riêng. Tạo key mới sẽ hủy các phiên panel cũ.</p><button type="button" className="text-button" onClick={() => setAccessKey(null)}>Đã sao chép</button></section>}
        {authenticated && dashboardLoaded && <nav className="admin-tabs" role="tablist" aria-label="Dashboard quản trị">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'button' : 'button secondary-action'} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === 'pending-requests' && pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}</button>)}</nav>}
        {(authenticated || !sessionChecked) && <section className="admin-tab-panel" role="tabpanel">{renderDashboard()}</section>}
      </div>
    </main>
  );
}
