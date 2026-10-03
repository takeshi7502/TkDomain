'use client';

import { FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { useNoticeToast } from '@/app/components/ToastProvider';
import styles from './admin.module.css';

type RequestStatus = 'pending' | 'active' | 'rejected' | 'cancelled' | 'released' | 'expired';
type DashboardTab = 'active-subdomains' | 'pending-requests' | 'request-log' | 'dns-log' | 'domains';
type ApprovalEmailResult = 'queued' | 'accepted' | 'not_requested' | 'not_configured' | 'failed' | 'busy' | 'manual_check' | 'key_changed' | 'inactive';

type RequestRecord = {
  id: string;
  subdomain: string;
  parentDomain: string;
  cnameTarget: string;
  recordType: string;
  recordPriority: number | null;
  telegramUsername: string | null;
  notificationEmail: string | null;
  notificationLanguage: string;
  approvalEmailSentAt: number | null;
  approvalEmailFirstAttemptAt: number | null;
  approvalEmailAttemptedAt: number | null;
  approvalEmailError: string | null;
  status: RequestStatus;
  createdAt: number;
  reviewedAt: number | null;
  cancelledAt: number | null;
  releasedAt: number | null;
  reviewerNote: string | null;
};

type AdminDnsRecord = {
  id: string;
  recordType: string;
  recordName: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
};

type ActiveSubdomain = {
  id: string;
  requestId: string | null;
  label: string;
  parentDomain: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  telegramUsername: string | null;
  recordCount: number;
  notificationEmail: string | null;
  records?: AdminDnsRecord[];
};

type DnsEvent = {
  id: string;
  subdomainId: string | null;
  domainLabel: string | null;
  parentDomain: string | null;
  currentDomainLabel: string | null;
  recordId: string | null;
  actorType: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: number;
};

type ManagedDomain = {
  id: string;
  hostname: string;
  status: 'active' | 'archived' | string;
  activeCount: number;
  pendingCount: number;
  createdAt: number;
  updatedAt: number;
};

type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;
type AdminState = 'idle' | 'loading';
type Summary = { active: number; pending: number; requests: number; events: number; domains: number; revision: string };
type DashboardPayload = { summary?: Summary; hasMore?: boolean; error?: string; requests?: RequestRecord[]; activeSubdomains?: ActiveSubdomain[]; dnsEvents?: DnsEvent[]; domains?: ManagedDomain[] };
type DomainMutationPayload = { error?: string; domains?: ManagedDomain[] };

type IconName = 'subdomain' | 'pending' | 'requests' | 'dns' | 'domain' | 'settings' | 'refresh' | 'logout' | 'external' | 'shield' | 'trash' | 'close';
const tabs: Array<{ id: DashboardTab; label: string; title: string; description: string; icon: IconName; count: keyof Omit<Summary, 'revision'> }> = [
  { id: 'active-subdomains', label: 'Subdomain đang dùng', title: 'Subdomain', description: 'Theo dõi chủ subdomain và mở từng mục để xem DNS records.', icon: 'subdomain', count: 'active' },
  { id: 'pending-requests', label: 'Chờ duyệt', title: 'Yêu cầu chờ duyệt', description: 'Kiểm tra thông tin đăng ký trước khi duyệt hoặc từ chối.', icon: 'pending', count: 'pending' },
  { id: 'request-log', label: 'Nhật ký yêu cầu', title: 'Nhật ký yêu cầu', description: 'Lịch sử đăng ký, trạng thái xử lý và thông báo email.', icon: 'requests', count: 'requests' },
  { id: 'dns-log', label: 'Nhật ký DNS', title: 'Nhật ký DNS', description: 'Theo dõi các thay đổi record và hoạt động của chủ subdomain.', icon: 'dns', count: 'events' },
  { id: 'domains', label: 'Domains', title: 'Domain gốc', description: 'Quản lý những domain mà registry nhận đăng ký subdomain.', icon: 'domain', count: 'domains' },
];

function AdminIcon({ name, className }: { name: IconName; className?: string }) {
  const paths: Record<IconName, string> = {
    subdomain: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    pending: 'M12 8v4l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    requests: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',
    dns: 'M3 12h4l3-7 4 14 3-7h4',
    domain: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-4 5-4 13 0 18 4-5 4-13 0-18',
    settings: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18A8 8 0 0 1 4 12',
    logout: 'M10 4H4v16h6 M8 12h13 M17 8l4 4-4 4',
    external: 'M14 3h7v7 M21 3l-9 9 M10 5H4v15h15v-6',
    shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
    trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
    close: 'M6 6l12 12 M6 18L18 6',
  };
  return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function recordHost(label: string, parentDomain: string, recordName: string) {
  return recordName === '@' ? `${label}.${parentDomain}` : `${recordName}.${label}.${parentDomain}`;
}

function ttlLabel(ttl: number) {
  return ttl === 1 ? 'Auto' : `${ttl}s`;
}

function requestStatusLabel(status: RequestStatus) {
  const labels: Record<RequestStatus, string> = {
    pending: 'Chờ duyệt',
    active: 'Đang dùng',
    rejected: 'Đã từ chối',
    cancelled: 'Người dùng đã hủy',
    released: 'Đã xoá / trả lại',
    expired: 'Đã hết hạn',
  };
  return labels[status];
}

function requestUpdatedAt(request: RequestRecord) {
  return request.cancelledAt ?? request.releasedAt ?? request.reviewedAt;
}

function approvalEmailStatus(request: RequestRecord) {
  if (!request.notificationEmail) return null;
  if (request.approvalEmailSentAt) return `Đã gửi ${formatDate(request.approvalEmailSentAt)}`;
  if (request.status !== 'active') return request.status === 'pending' ? 'Sẽ gửi khi duyệt' : 'Không gửi email duyệt';
  if (request.approvalEmailError === 'not_configured') return 'Chưa cấu hình Resend';
  if (request.approvalEmailError === 'recipient_rate_limit') return 'Đang giới hạn gửi';
  if (request.approvalEmailError) return 'Gửi lỗi';
  if (request.approvalEmailAttemptedAt) return 'Chưa xác nhận gửi';
  return 'Chờ gửi';
}

function approvalEmailNotice(result: ApprovalEmailResult | undefined, successText: string): Notice {
  if (!result || result === 'not_requested') return { tone: 'success', text: successText };
  if (result === 'queued') return { tone: 'success', text: `${successText} Email đã được xếp hàng gửi.` };
  if (result === 'accepted') return { tone: 'success', text: `${successText} Email duyệt đã được gửi.` };
  if (result === 'not_configured') return { tone: 'error', text: `${successText} Chưa gửi email vì Vercel còn thiếu RESEND_API_KEY hoặc EMAIL_FROM.` };
  if (result === 'busy') return { tone: 'info', text: 'Email đang được xử lý hoặc vừa được thử gửi. Hãy chờ ít nhất 1 phút rồi tải lại.' };
  if (result === 'key_changed') return { tone: 'error', text: 'Access key đã được đổi sau khi duyệt. Không gửi lại email chứa key cũ; hãy liên hệ chủ subdomain để xác minh.' };
  if (result === 'manual_check') return { tone: 'error', text: 'Lần gửi đầu đã quá lâu. Kiểm tra Resend dashboard trước khi gửi thủ công để tránh gửi trùng.' };
  if (result === 'inactive') return { tone: 'error', text: 'Chỉ có thể gửi email duyệt cho request đang active.' };
  return { tone: 'error', text: `${successText} Gửi email thất bại; có thể thử lại sau ít nhất 1 phút trong Nhật ký yêu cầu.` };
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
    owner_access_key_changed: 'Chủ subdomain đổi access key',
    owner_access_key_recovered: 'Khôi phục access key qua Telegram',
    telegram_linked: 'Liên kết Telegram bot',
    telegram_link_refreshed: 'Làm mới liên kết Telegram',
    telegram_unlinked: 'Hủy liên kết Telegram',
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
  const [domains, setDomains] = useState<ManagedDomain[]>([]);
  const [activeTab, setActiveTab] = useState<DashboardTab>('active-subdomains');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recordDetails, setRecordDetails] = useState<Record<string, AdminDnsRecord[]>>({});
  const [recordMore, setRecordMore] = useState<Record<string, boolean>>({});
  const [loadingRecords, setLoadingRecords] = useState<string | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const recordDetailsRef = useRef<Record<string, AdminDnsRecord[]>>({});
  const requestSeq = useRef(0);
  const revision = useRef('');
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [state, setState] = useState<AdminState>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  useNoticeToast(notice);
  const [accessKey, setAccessKey] = useState<{ subdomain: string; value: string } | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [expandedSubdomainId, setExpandedSubdomainId] = useState<string | null>(null);
  const [rejectingRequestId, setRejectingRequestId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [configuringTelegramWebhook, setConfiguringTelegramWebhook] = useState(false);
  const [newDomainHostname, setNewDomainHostname] = useState('');
  const [addingDomain, setAddingDomain] = useState(false);
  const [archivingDomainId, setArchivingDomainId] = useState<string | null>(null);
  const polling = useRef(false);
  const domainActioning = useRef(false);
  const actingOnRef = useRef<string | null>(null);
  const stateRef = useRef<AdminState>('idle');
  const authenticatedRef = useRef(false);
  const deletionDialog = useRef<HTMLDialogElement>(null);
  const [deletingDomain, setDeletingDomain] = useState<ActiveSubdomain | null>(null);
  const [deletionReason, setDeletionReason] = useState('');
  const [deletionConfirmation, setDeletionConfirmation] = useState('');
  const [sendDeletionEmail, setSendDeletionEmail] = useState(true);
  const [deletionError, setDeletionError] = useState('');
  const deletionOperationId = useRef('');

  useEffect(() => {
    const dialog = deletionDialog.current;
    if (deletingDomain && authenticated && dialog && !dialog.open) dialog.showModal();
    else if (!deletingDomain && dialog?.open) dialog.close();
  }, [deletingDomain, authenticated]);

  const setAdminAuthenticated = useCallback((value: boolean) => {
    authenticatedRef.current = value;
    setAuthenticated(value);
  }, []);

  const pendingRequests = requests.filter((request) => request.status === 'pending');

  const loadDashboard = useCallback(async ({ clearNotice = true, silent = false }: { clearNotice?: boolean; silent?: boolean } = {}) => {
    const seq = ++requestSeq.current;
    if (!silent) { stateRef.current = 'loading'; setState('loading'); }
    if (clearNotice) setNotice(null);
    try {
      if (silent) {
        const check = await fetch('/api/admin/requests?tab=summary', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
        if (check.status === 401) { setAdminAuthenticated(false); setDashboardLoaded(false); return; }
        if (!check.ok) return;
        const counts = await check.json() as DashboardPayload;
        if (seq !== requestSeq.current) return;
        if (counts.summary) setSummary(counts.summary);
        if (counts.summary?.revision === revision.current) return;
      }
      const response = await fetch(`/api/admin/requests?tab=${activeTab}&page=${page}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const payload = await response.json() as DashboardPayload;
      if (seq !== requestSeq.current) return;
      if (!response.ok) {
        if (response.status === 401) { setAdminAuthenticated(false); setDashboardLoaded(false); return; }
        throw new Error(payload.error ?? 'Không thể tải dữ liệu quản trị.');
      }
      setAdminAuthenticated(true);
      setRequests(payload.requests ?? []);
      const domains = payload.activeSubdomains ?? [];
      setActiveSubdomains(domains);
      setExpandedSubdomainId((id) => domains.some((d) => d.id === id) ? id : null);
      setDnsEvents(payload.dnsEvents ?? []);
      setDomains(payload.domains ?? []);
      setSummary(payload.summary ?? null);
      setHasMore(Boolean(payload.hasMore));
      revision.current = payload.summary?.revision ?? '';
      recordDetailsRef.current = {};
      setRecordDetails({});
      setRecordMore({});
      setDashboardLoaded(true);
    } catch (error) {
      if (!silent && seq === requestSeq.current) setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải dashboard.' });
    } finally {
      if (seq === requestSeq.current) { setSessionChecked(true); if (!silent) { stateRef.current = 'idle'; setState('idle'); } }
    }
  }, [activeTab, page, setAdminAuthenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadDashboard({ clearNotice: false }); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  const loadRecordDetails = useCallback(async (id: string, append = false) => {
    setLoadingRecords(id);
    try {
      const nextPage = append ? Math.floor((recordDetailsRef.current[id]?.length ?? 0) / 50) : 0;
      const response = await fetch(`/api/admin/requests?subdomainId=${encodeURIComponent(id)}&page=${nextPage}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as { records?: AdminDnsRecord[]; error?: string; hasMore?: boolean };
      if (!response.ok || !data.records) throw new Error(data.error ?? 'Không thể tải records.');
      const records = append ? [...(recordDetailsRef.current[id] ?? []), ...data.records] : data.records;
      recordDetailsRef.current = { ...recordDetailsRef.current, [id]: records };
      setRecordDetails(recordDetailsRef.current);
      setRecordMore((current) => ({ ...current, [id]: Boolean(data.hasMore) }));
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể tải records.' });
    } finally { setLoadingRecords((current) => current === id ? null : current); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (expandedSubdomainId && !recordDetails[expandedSubdomainId]) void loadRecordDetails(expandedSubdomainId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [expandedSubdomainId, recordDetails, loadRecordDetails]);

  useEffect(() => {
    if (!authenticated) return;
    const poll = () => {
      if (document.visibilityState !== 'visible' || polling.current || actingOnRef.current || domainActioning.current || stateRef.current !== 'idle') return;
      polling.current = true;
      void loadDashboard({ clearNotice: false, silent: true }).finally(() => { polling.current = false; });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    window.addEventListener('visibilitychange', refreshWhenVisible);
    const interval = window.setInterval(poll, 30_000);
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
    requestSeq.current += 1;
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
      setDomains([]);
      setAccessKey(null);
      setDeletingDomain(null);
      setExpandedSubdomainId(null);
      setRejectingRequestId(null);
      setRejectionReason('');
      setNewDomainHostname('');
      setAddingDomain(false);
      setArchivingDomainId(null);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể đăng xuất phiên admin.' });
    } finally {
      stateRef.current = 'idle';
      setState('idle');
    }
  }

  async function testTelegram() {
    if (testingTelegram) return;
    setTestingTelegram(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/telegram', { method: 'POST' });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể gửi tin nhắn test Telegram.');
      setNotice({ tone: 'success', text: 'Đã gửi tin nhắn test vào Telegram của admin.' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể gửi tin nhắn test Telegram.' });
    } finally {
      setTestingTelegram(false);
    }
  }

  async function configureTelegramWebhook() {
    if (configuringTelegramWebhook) return;
    setConfiguringTelegramWebhook(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'configure-webhook' }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể cài webhook Telegram.');
      setNotice({ tone: 'success', text: payload.message ?? 'Webhook bot đã được cài.' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cài webhook Telegram.' });
    } finally {
      setConfiguringTelegramWebhook(false);
    }
  }

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hostname = newDomainHostname.trim();
    if (!hostname || addingDomain || archivingDomainId) return;

    domainActioning.current = true;
    setAddingDomain(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname }),
      });
      const payload = await response.json() as DomainMutationPayload;
      if (!response.ok || !Array.isArray(payload.domains)) throw new Error(payload.error ?? 'Không thể thêm domain vào registry.');
      setDomains(payload.domains);
      setNewDomainHostname('');
      setNotice({ tone: 'success', text: `${hostname} đã sẵn sàng để nhận đăng ký subdomain.` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể thêm domain vào registry.' });
    } finally {
      domainActioning.current = false;
      setAddingDomain(false);
    }
  }

  async function archiveDomain(domain: ManagedDomain) {
    if (domain.status !== 'active' || addingDomain || archivingDomainId) return;
    const confirmed = window.confirm(
      `Gỡ ${domain.hostname} khỏi registry?\n\nThao tác này chỉ dừng nhận đăng ký subdomain mới. Cloudflare zone và DNS records không bị xóa. Domain chỉ có thể gỡ khi không còn subdomain active hoặc yêu cầu chờ duyệt.`,
    );
    if (!confirmed) return;

    domainActioning.current = true;
    setArchivingDomainId(domain.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/domains?id=${encodeURIComponent(domain.id)}`, { method: 'DELETE' });
      const payload = await response.json() as DomainMutationPayload;
      if (!response.ok || !Array.isArray(payload.domains)) throw new Error(payload.error ?? 'Không thể gỡ domain khỏi registry.');
      setDomains(payload.domains);
      setNotice({ tone: 'success', text: `${domain.hostname} đã được gỡ khỏi registry. Cloudflare không bị thay đổi.` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể gỡ domain khỏi registry.' });
    } finally {
      domainActioning.current = false;
      setArchivingDomainId(null);
    }
  }

  async function review(id: string, action: 'provision' | 'reject' | 'reset_access' | 'retry_email', note?: string) {
    const label = action === 'provision' ? 'duyệt và tạo DNS' : action === 'reject' ? 'từ chối' : action === 'reset_access' ? 'tạo access key mới' : 'gửi lại email duyệt';
    if (action !== 'reject' && !window.confirm(`Bạn muốn ${label} request này?`)) return;
    actingOnRef.current = id;
    setActingOn(id);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...(action === 'reject' ? { note } : {}) }),
      });
      const payload = await response.json() as { error?: string; ownerAccessKey?: string; accessKeyProvided?: boolean; subdomain?: string; approvalEmail?: ApprovalEmailResult };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể cập nhật request.');
      if (payload.ownerAccessKey && payload.subdomain) {
        setAccessKey({ subdomain: payload.subdomain, value: payload.ownerAccessKey });
        setNotice(action === 'reset_access'
          ? { tone: 'success', text: 'Access key mới nằm bên dưới. Gửi riêng cho chủ subdomain.' }
          : approvalEmailNotice(payload.approvalEmail, 'DNS đã sẵn sàng. Access key nằm bên dưới để admin xử lý nếu email chưa đến.'));
      } else {
        const successText = action === 'reject'
          ? 'Đã từ chối request.'
          : action === 'retry_email'
            ? 'Đã xử lý yêu cầu gửi email duyệt.'
            : payload.accessKeyProvided
              ? 'DNS đã sẵn sàng. Chủ subdomain sẽ dùng access key đã tự đặt khi đăng ký.'
              : 'DNS đã sẵn sàng.';
        setNotice(action === 'reject' || action === 'reset_access'
          ? { tone: 'success', text: successText }
          : approvalEmailNotice(payload.approvalEmail, successText));
      }
      if (action === 'reject') {
        setRejectingRequestId(null);
        setRejectionReason('');
      }
      await loadDashboard({ clearNotice: false });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Không thể cập nhật request.' });
    } finally {
      actingOnRef.current = null;
      setActingOn(null);
    }
  }

  function openRejectEditor(id: string) {
    if (actingOn) return;
    setRejectingRequestId(id);
    setRejectionReason('');
    setNotice(null);
  }

  function closeRejectEditor() {
    if (actingOn) return;
    setRejectingRequestId(null);
    setRejectionReason('');
  }

  function submitRejection(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const reason = rejectionReason.trim();
    if (reason.length < 3 || reason.length > 500) return;
    void review(id, 'reject', reason);
  }

  function openDeletion(domain: ActiveSubdomain) {
    if (actingOnRef.current || stateRef.current !== 'idle' || domain.status === 'deleting') return;
    setDeletionReason('');
    setDeletionConfirmation('');
    setSendDeletionEmail(Boolean(domain.notificationEmail));
    setDeletionError('');
    deletionOperationId.current = crypto.randomUUID();
    setDeletingDomain(domain);
  }

  function closeDeletion() {
    if (actingOnRef.current) return;
    setDeletingDomain(null);
    setDeletionError('');
  }

  async function submitDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deletingDomain || actingOnRef.current) return;
    const hostname = `${deletingDomain.label}.${deletingDomain.parentDomain}`;
    const reason = deletionReason.trim();
    if (deletionConfirmation !== hostname || reason.length < 3 || reason.length > 500) return;
    const id = deletingDomain.id;
    actingOnRef.current = id;
    setActingOn(id);
    setDeletionError('');
    try {
      const response = await fetch('/api/admin/subdomains', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ subdomainId: id, operationId: deletionOperationId.current, confirmation: hostname, reason, notifyEmail: sendDeletionEmail }),
      });
      const payload = await response.json() as { error?: string; pending?: boolean; deletionEmail?: 'queued' | 'skipped' };
      if (!response.ok) throw new Error(payload.error ?? 'Không thể xoá subdomain.');
      setDeletingDomain(null);
      setAccessKey(null);
      setNotice(payload.pending
        ? { tone: 'info', text: `Đã nhận yêu cầu xoá ${hostname}. DNS đang được dọn; dữ liệu sẽ được giải phóng khi hoàn tất.${sendDeletionEmail ? ' Email sẽ được gửi sau đó.' : ''}` }
        : { tone: 'success', text: `Đã xoá ${hostname} cùng toàn bộ DNS records.${payload.deletionEmail === 'queued' ? ' Email đã được xếp hàng gửi.' : ' Không gửi email thông báo.'}` });
      await loadDashboard({ clearNotice: false });
    } catch (error) {
      setDeletionError(error instanceof Error ? error.message : 'Không thể xoá subdomain.');
    } finally {
      actingOnRef.current = null;
      setActingOn(null);
    }
  }

  function renderAdminAction(
    id: string,
    action: 'provision' | 'reject' | 'reset_access' | 'retry_email',
    label: string,
    symbol: string,
    danger = false,
  ) {
    const busy = actingOn === id;
    return <button
      type="button"
      className={`admin-icon-action${danger ? ' danger' : ''}`}
      onClick={() => {
        if (action === 'reject') {
          openRejectEditor(id);
          return;
        }
        closeRejectEditor();
        void review(id, action);
      }}
      disabled={busy || state !== 'idle'}
      title={busy ? 'Đang xử lý' : label}
      aria-label={busy ? 'Đang xử lý' : label}
    >{busy ? '…' : symbol}</button>;
  }

  function renderRequestRow(request: RequestRecord, showActions = false) {
    const updatedAt = requestUpdatedAt(request);
    const emailStatus = approvalEmailStatus(request);
    const rejectEditorOpen = rejectingRequestId === request.id;
    const reasonLength = rejectionReason.trim().length;
    return <article className={`panel admin-list-row${rejectEditorOpen ? ' rejecting' : ''}`} key={request.id}>
      <div className="admin-row-main">
        <h2 className="admin-row-title">{request.subdomain}<span>.{request.parentDomain}</span></h2>
        <div className="admin-row-meta">
          <span title={`${request.recordType}: ${request.cnameTarget}`}><b>{request.recordType}</b>{request.cnameTarget}{request.recordPriority !== null ? ` · priority ${request.recordPriority}` : ''}</span>
          <span><b>Telegram</b>{request.telegramUsername ? `@${request.telegramUsername}` : 'Yêu cầu cũ'}</span>
          {request.notificationEmail && <span title={`Email duyệt: ${request.notificationEmail}`}><b>Email duyệt</b>{request.notificationEmail}</span>}
          {emailStatus && <span><b>Trạng thái email</b>{emailStatus}</span>}
          <span><b>Gửi</b>{formatDate(request.createdAt)}</span>
          {updatedAt && <span><b>Cập nhật</b>{formatDate(updatedAt)}</span>}
        </div>
        {request.reviewerNote && <p className="admin-row-note" title={request.reviewerNote}>{request.status === 'rejected' ? 'Lý do từ chối: ' : 'Ghi chú: '}{request.reviewerNote}</p>}
      </div>
      <div className="admin-row-side">
        <StatusBadge status={request.status} label={requestStatusLabel(request.status)} />
        {showActions && <div className="admin-row-actions">
          {renderAdminAction(request.id, 'provision', 'Duyệt và tạo DNS', '✓')}
          {renderAdminAction(request.id, 'reject', 'Từ chối yêu cầu', '×', true)}
        </div>}
        {!showActions && request.status === 'active' && <div className="admin-row-actions">
          {request.notificationEmail && !request.approvalEmailSentAt && renderAdminAction(request.id, 'retry_email', 'Gửi hoặc thử lại email duyệt', '✉')}
          {renderAdminAction(request.id, 'reset_access', 'Tạo access key mới', '↻')}
        </div>}
      </div>
      {showActions && rejectEditorOpen && <form className="admin-reject-editor" onSubmit={(event) => submitRejection(event, request.id)}>
        <label htmlFor={`reject-reason-${request.id}`}>Lý do từ chối
          <textarea
            id={`reject-reason-${request.id}`}
            className="field"
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value)}
            placeholder="Ví dụ: nội dung record chưa đúng hoặc tên chưa phù hợp."
            minLength={3}
            maxLength={500}
            rows={3}
            autoFocus
            required
          />
        </label>
        <div className="admin-reject-editor-actions">
          <small>{reasonLength}/500 ký tự · tối thiểu 3 ký tự</small>
          <div>
            <button className="button reject" type="submit" disabled={actingOn === request.id || reasonLength < 3}>Xác nhận từ chối</button>
            <button className="button secondary-action" type="button" onClick={closeRejectEditor} disabled={actingOn === request.id}>Hủy</button>
          </div>
        </div>
      </form>}
    </article>;
  }

  function renderDashboard() {
    if (state === 'loading' && authenticated) return <div className="panel empty-state">Đang tải dữ liệu...</div>;
    if (!dashboardLoaded) return <div className="panel empty-state">{sessionChecked ? 'Nhập admin key để tải dashboard.' : 'Đang khôi phục phiên admin...'}</div>;

    if (activeTab === 'domains') {
      const domainBusy = addingDomain || archivingDomainId !== null;
      return <>
        <div className={styles.domainSetup}>
        <form className="admin-key-form" onSubmit={addDomain}>
          <label htmlFor="new-domain-hostname">Thêm domain gốc
            <input
              id="new-domain-hostname"
              className="field"
              value={newDomainHostname}
              onChange={(event) => setNewDomainHostname(event.target.value)}
              placeholder="example.dev"
              autoComplete="off"
              spellCheck={false}
              disabled={domainBusy}
              required
            />
          </label>
          <button className="button" type="submit" disabled={domainBusy || !newDomainHostname.trim()}>{addingDomain ? 'Đang thêm...' : 'Thêm domain'}</button>
        </form>
        <p className="note">Domain phải đang active trên Cloudflare. Token cần quyền DNS Edit và Zone Read; server tự đọc Zone ID.</p>
        </div>
        {domains.length === 0
          ? <div className="panel empty-state">Chưa có domain gốc nào trong registry.</div>
          : <div className="request-list">{domains.map((domain) => {
            const isActive = domain.status === 'active';
            const isArchiving = archivingDomainId === domain.id;
            return <article className="panel admin-list-row" key={domain.id}>
              <div className="admin-row-main">
                <h2 className="admin-row-title">{domain.hostname}</h2>
                <div className="admin-row-meta">
                  <span><b>Subdomain active</b>{domain.activeCount}</span>
                  <span><b>Chờ duyệt</b>{domain.pendingCount}</span>
                  <span><b>Cập nhật</b>{formatDate(domain.updatedAt)}</span>
                </div>
              </div>
              <div className="admin-row-side">
                <StatusBadge status={isActive ? 'active' : 'rejected'} label={isActive ? 'Đang nhận đăng ký' : 'Đã gỡ'} />
                {isActive && <div className="admin-row-actions"><button type="button" className="admin-icon-action danger" onClick={() => void archiveDomain(domain)} disabled={domainBusy} title={isArchiving ? 'Đang gỡ' : `Gỡ ${domain.hostname} khỏi registry`} aria-label={isArchiving ? 'Đang gỡ' : `Gỡ ${domain.hostname} khỏi registry`}>{isArchiving ? '…' : '×'}</button></div>}
              </div>
            </article>;
          })}</div>}
      </>;
    }

    if (activeTab === 'active-subdomains') {
      return activeSubdomains.length === 0
        ? <div className="panel empty-state">Chưa có subdomain nào đang hoạt động.</div>
        : <div className="request-list">{activeSubdomains.map((domain) => {
          const expanded = expandedSubdomainId === domain.id;
          const records = recordDetails[domain.id] ?? [];
          return <article className={`panel admin-list-row${expanded ? ' expanded' : ''}`} key={domain.id}>
            <div className="admin-row-main">
              <button
                type="button"
                className="admin-domain-toggle"
                onClick={() => setExpandedSubdomainId((current) => current === domain.id ? null : domain.id)}
                aria-expanded={expanded}
                aria-controls={`admin-records-${domain.id}`}
                title={expanded ? `Ẩn DNS records của ${domain.label}.${domain.parentDomain}` : `Xem DNS records của ${domain.label}.${domain.parentDomain}`}
              >
                <span className="admin-row-title">{domain.label}<span>.{domain.parentDomain}</span></span>
                <span className="admin-expand-mark" aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>
              <div className="admin-row-meta">
                <span><b>Telegram</b>{domain.telegramUsername ? `@${domain.telegramUsername}` : 'Không có dữ liệu'}</span>
                <span><b>Records con</b>{domain.recordCount}</span>
                <span><b>Cập nhật</b>{formatDate(domain.updatedAt)}</span>
              </div>
            </div>
            <div className="admin-row-side">
              <StatusBadge status={domain.status === 'deleting' ? 'pending' : domain.status} label={domain.status === 'active' ? 'Đang dùng' : domain.status === 'deleting' ? 'Đang xoá' : domain.status} />
              <div className="admin-row-actions">
                {domain.requestId && domain.status !== 'deleting' && renderAdminAction(domain.requestId, 'reset_access', `Tạo access key mới cho ${domain.label}.${domain.parentDomain}`, '↻')}
                <button type="button" className="admin-icon-action danger" disabled={Boolean(actingOn) || state !== 'idle' || domain.status === 'deleting'} title={`Xoá ${domain.label}.${domain.parentDomain}`} aria-label={`Xoá ${domain.label}.${domain.parentDomain}`} onClick={() => openDeletion(domain)}><AdminIcon name="trash" /></button>
              </div>
            </div>
            {expanded && <section className="admin-records-inspector" id={`admin-records-${domain.id}`} aria-label={`DNS records của ${domain.label}.${domain.parentDomain}`}>
              <div className="admin-records-heading">
                <div><p className="eyebrow"><span className="pixel-dot" /> DNS RECORDS</p><p>Toàn bộ record đang thuộc <strong>{domain.label}.{domain.parentDomain}</strong>.</p></div>
                <span className="status">{recordDetails[domain.id] ? `${records.length}${recordMore[domain.id] ? '+' : ''} records` : 'Đang tải'}</span>
              </div>
              {loadingRecords === domain.id && <p className="note">Đang tải records...</p>}
              {records.length === 0 && recordDetails[domain.id] && loadingRecords !== domain.id
                ? <p className="admin-records-empty">Chưa có DNS record nào trong database.</p>
                : <div className="admin-record-list">{records.map((record) => <article className={`admin-dns-record${record.isPrimary ? ' primary' : ''}`} key={record.id}>
                  <span className="admin-record-type">{record.recordType}</span>
                  <div className="admin-dns-record-main">
                    <div className="admin-record-host"><strong>{recordHost(domain.label, domain.parentDomain, record.recordName)}</strong>{record.isPrimary && <span>PRIMARY</span>}</div>
                    <code>{record.content}{record.priority !== null ? ` · priority ${record.priority}` : ''}</code>
                    <small>{ttlLabel(record.ttl)}{record.proxied ? ' · proxied' : ' · DNS only'}</small>
                  </div>
                </article>)}</div>}
              {recordMore[domain.id] && <button className="button secondary-action" type="button" disabled={loadingRecords === domain.id} onClick={() => void loadRecordDetails(domain.id, true)}>Tải thêm record</button>}
            </section>}
          </article>;
        })}</div>;
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
        const hostname = domainLabel && event.parentDomain ? `${domainLabel}.${event.parentDomain}` : domainLabel;
        return <article className="panel admin-list-row" key={event.id}>
          <div className="admin-row-main">
            <h2 className="admin-row-title">{hostname ? event.parentDomain ? <>{domainLabel}<span>.{event.parentDomain}</span></> : hostname : 'Subdomain đã xóa'}</h2>
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

  function navigateToTab(tab: DashboardTab) {
    setPage(0);
    setActiveTab(tab);
  }

  function navigateWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    navigateToTab(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  async function runSynchronization() {
    if (maintenanceBusy) return;
    setMaintenanceBusy(true);
    try {
      const r = await fetch('/api/maintenance', { method: 'POST', signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error();
      setNotice({ tone: 'success', text: 'Đã chạy kiểm tra đồng bộ và retry thông báo.' });
      await loadDashboard({ clearNotice: false });
    } catch {
      setNotice({ tone: 'error', text: 'Không thể chạy kiểm tra lúc này.' });
    } finally { setMaintenanceBusy(false); }
  }

  const currentTab = tabs.find((tab) => tab.id === activeTab)!;
  const rowCount = activeTab === 'active-subdomains' ? activeSubdomains.length
    : activeTab === 'pending-requests' ? pendingRequests.length
      : activeTab === 'request-log' ? requests.length
        : activeTab === 'dns-log' ? dnsEvents.length : domains.length;
  const totalCount = summary?.[currentTab.count];
  const summaryCards: Array<{ tab: DashboardTab; label: string; detail: string; icon: IconName; value: number | undefined }> = [
    { tab: 'active-subdomains', label: 'Subdomain đang dùng', detail: 'Trong registry', icon: 'subdomain', value: summary?.active },
    { tab: 'pending-requests', label: 'Chờ duyệt', detail: 'Cần được kiểm tra', icon: 'pending', value: summary?.pending },
    { tab: 'domains', label: 'Domain gốc', detail: 'Đã thêm vào registry', icon: 'domain', value: summary?.domains },
    { tab: 'request-log', label: 'Tổng yêu cầu', detail: 'Toàn bộ lịch sử đăng ký', icon: 'requests', value: summary?.requests },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/admin" className={styles.brand} aria-label="Takeshi Domains Admin">
            <span className={styles.brandMark}>Tk</span><span>TAKESHI <b>DOMAINS</b></span><small>ADMIN</small>
          </Link>
          <div className={styles.topbarActions}>
            <Link href="/" className={styles.siteLink}><AdminIcon name="external" /><span>Trang đăng ký</span></Link>
            {authenticated && <><span className={styles.account}><AdminIcon name="shield" /> Quản trị viên</span><button className={styles.logout} type="button" onClick={() => void logout()} disabled={state === 'loading'} title="Đăng xuất admin" aria-label="Đăng xuất admin"><AdminIcon name="logout" /></button></>}
          </div>
        </div>
      </header>

      {!authenticated ? <main className={styles.login}>
        <section className={styles.loginCard} aria-busy={!sessionChecked || state === 'loading'}>
          <div className={styles.loginIcon}><AdminIcon name="shield" /></div>
          <p className={styles.overline}>PRIVATE CONSOLE</p>
          <h1>Quản trị registry</h1>
          <p className={styles.loginCopy}>Đăng nhập để quản lý subdomain, duyệt yêu cầu và theo dõi hoạt động DNS.</p>
          {sessionChecked ? <form onSubmit={startSession}>
            <label htmlFor="admin-key">Admin key<input id="admin-key" className="field" type="password" value={key} onChange={(event) => { setKey(event.target.value); setDashboardLoaded(false); }} autoComplete="off" required /></label>
            <button type="submit" className="button" disabled={state === 'loading'}>{state === 'loading' ? 'Đang mở...' : 'Đăng nhập Admin'}</button>
          </form> : <p className={styles.restoring} role="status">Đang khôi phục phiên admin...</p>}
          <p className={styles.loginPrivacy}><AdminIcon name="shield" /> Phiên được giữ bằng cookie HTTP-only. Key không được lưu trong trình duyệt.</p>
        </section>
      </main> : <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <p className={styles.navLabel}>QUẢN LÝ REGISTRY</p>
          <nav className={styles.navigation} role="tablist" aria-label="Dashboard quản trị" aria-orientation="vertical">
            {tabs.map((tab, index) => <button key={tab.id} id={`admin-nav-${tab.id}`} type="button" role="tab" tabIndex={activeTab === tab.id ? 0 : -1} aria-selected={activeTab === tab.id} aria-controls="admin-content" className={`${styles.navItem}${activeTab === tab.id ? ` ${styles.navItemActive}` : ''}`} onClick={() => navigateToTab(tab.id)} onKeyDown={(event) => navigateWithKeyboard(event, index)}>
              <AdminIcon name={tab.icon} /><span>{tab.label}</span><small className={tab.id === 'pending-requests' && (summary?.pending ?? 0) > 0 ? styles.pendingCount : undefined}>{summary?.[tab.count] ?? '—'}</small>
            </button>)}
          </nav>
          <details className={styles.tools}>
            <summary><AdminIcon name="settings" /> Công cụ hệ thống <span aria-hidden="true">+</span></summary>
            <div>
              <button type="button" onClick={() => void runSynchronization()} disabled={maintenanceBusy}>{maintenanceBusy ? 'Đang đồng bộ...' : 'Kiểm tra đồng bộ'}</button>
              <button type="button" onClick={() => void testTelegram()} disabled={testingTelegram}>{testingTelegram ? 'Đang gửi test...' : 'Test bot Telegram'}</button>
              <button type="button" onClick={() => void configureTelegramWebhook()} disabled={configuringTelegramWebhook}>{configuringTelegramWebhook ? 'Đang cài webhook...' : 'Cài webhook bot'}</button>
            </div>
          </details>
          <div className={styles.sidebarFoot}><AdminIcon name="shield" /><p>Phiên admin đã xác thực.<br /><span>Chỉ dành cho quản trị viên.</span></p></div>
        </aside>

        <main className={styles.main}>
          <div className={styles.heading}>
            <div><p className={styles.breadcrumb}>Admin <span>/</span> {currentTab.label}</p><h1>{currentTab.title}</h1><p className={styles.description}>{currentTab.description}</p></div>
            <button className={styles.refresh} type="button" disabled={state !== 'idle' || Boolean(actingOn) || addingDomain || Boolean(archivingDomainId) || maintenanceBusy} onClick={() => void loadDashboard()}><AdminIcon name="refresh" className={state === 'loading' ? styles.spinning : undefined} /> Làm mới</button>
          </div>

          <section className={styles.stats} aria-label="Tổng quan registry">
            {summaryCards.map((card) => <div className={`${styles.stat}${card.tab === 'pending-requests' && (card.value ?? 0) > 0 ? ` ${styles.statPending}` : ''}`} key={card.tab}>
              <span className={styles.statLabel}>{card.label}<AdminIcon name={card.icon} /></span><strong>{card.value ?? '—'}</strong><small>{card.detail}</small>
            </div>)}
          </section>

          {accessKey && <section className={`panel owner-key-panel ${styles.keyPanel}`}><div><p className="eyebrow"><span className="pixel-dot" /> OWNER ACCESS KEY</p><h2>{accessKey.subdomain}</h2></div><button type="button" className={styles.refresh} onClick={() => setAccessKey(null)}>Ẩn key</button><code>{accessKey.value}</code><p className="note">Gửi key này qua kênh riêng. Tạo key mới sẽ hủy các phiên panel cũ.</p></section>}

          <section className={styles.dataSurface} id="admin-content" role="tabpanel" aria-labelledby={`admin-nav-${activeTab}`} aria-busy={state === 'loading'}>
            <div className={styles.listHeading}><div><AdminIcon name={currentTab.icon} /><h2>{currentTab.label}</h2>{totalCount !== undefined && <span>{totalCount}</span>}</div><small>Tự cập nhật mỗi 30 giây</small></div>
            <div className={styles.dataBody}>{renderDashboard()}</div>
            {dashboardLoaded && <div className={styles.pagination}>
              <p>{state === 'loading' ? 'Đang tải dữ liệu...' : rowCount > 0 ? <>Hiển thị <b>{page * 50 + 1}–{page * 50 + rowCount}</b>{totalCount !== undefined ? ` / ${totalCount}` : ''} mục</> : '0 mục'}</p>
              <div><button type="button" disabled={page === 0 || state !== 'idle'} onClick={() => setPage((p) => p - 1)} aria-label="Trang trước">←</button><span>Trang {page + 1}</span><button type="button" disabled={!hasMore || state !== 'idle'} onClick={() => setPage((p) => p + 1)} aria-label="Trang sau">→</button></div>
            </div>}
          </section>
        </main>
      </div>}
      {authenticated && <dialog ref={deletionDialog} className={styles.deletionDialog} aria-labelledby="delete-subdomain-title" aria-describedby="delete-subdomain-warning" onCancel={(event) => { event.preventDefault(); closeDeletion(); }}>
        {deletingDomain && <form onSubmit={submitDeletion}>
          <div className={styles.dialogHeading}><div><p>QUẢN TRỊ SUBDOMAIN</p><h2 id="delete-subdomain-title">Xoá subdomain</h2></div><button type="button" onClick={closeDeletion} disabled={Boolean(actingOn)} aria-label="Đóng xác nhận xoá"><AdminIcon name="close" /></button></div>
          <p className={styles.deleteHostname}>{deletingDomain.label}.{deletingDomain.parentDomain}</p>
          <p id="delete-subdomain-warning" className={styles.deleteWarning}>Toàn bộ DNS records và quyền quản lý subdomain này sẽ bị xoá. Tên được trả lại để đăng ký mới. Không thể hoàn tác từ panel; nhật ký vẫn được giữ.</p>
          <fieldset disabled={Boolean(actingOn)}>
            <label htmlFor="delete-subdomain-reason">Lý do xoá <small>(bắt buộc)</small></label>
            <textarea id="delete-subdomain-reason" className="field" rows={3} autoFocus required minLength={3} maxLength={500} value={deletionReason} onChange={(event) => { setDeletionReason(event.target.value); setDeletionError(''); deletionOperationId.current = crypto.randomUUID(); }} placeholder="Nhập lý do để lưu vào nhật ký và email thông báo." />
            <p className={styles.dialogHint}>{deletionReason.trim().length}/500 ký tự · tối thiểu 3 ký tự</p>
            <label className={styles.emailChoice}><input type="checkbox" checked={sendDeletionEmail} disabled={!deletingDomain.notificationEmail} onChange={(event) => { setSendDeletionEmail(event.target.checked); deletionOperationId.current = crypto.randomUUID(); }} /><span>Gửi email thông báo cho người dùng<small>{deletingDomain.notificationEmail ?? 'Subdomain này chưa có email nhận thông báo; sẽ xoá không gửi thư.'}</small></span></label>
            <label htmlFor="delete-subdomain-confirm">Nhập lại <strong>{deletingDomain.label}.{deletingDomain.parentDomain}</strong> để xác nhận</label>
            <input id="delete-subdomain-confirm" className="field" value={deletionConfirmation} onChange={(event) => { setDeletionConfirmation(event.target.value); setDeletionError(''); }} autoComplete="off" spellCheck={false} required />
          </fieldset>
          {deletionError && <p className={styles.dialogError} role="alert">{deletionError}</p>}
          <div className={styles.dialogActions}><button type="button" className={styles.refresh} onClick={closeDeletion} disabled={Boolean(actingOn)}>Huỷ</button><button type="submit" className={`button reject ${styles.deleteSubmit}`} disabled={Boolean(actingOn) || deletionConfirmation !== `${deletingDomain.label}.${deletingDomain.parentDomain}` || deletionReason.trim().length < 3 || deletionReason.trim().length > 500}>{actingOn ? 'Đang xoá...' : 'Xác nhận xoá'}</button></div>
        </form>}
      </dialog>}
    </div>
  );
}
