'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { HoldToRevealButton } from '@/app/components/HoldToRevealButton';
import { useNoticeToast } from '@/app/components/ToastProvider';
import { UserLanguageToggle, useUserLanguage } from '@/app/components/UserLanguageToggle';
import { isValidOwnerAccessKey, isValidTelegramUsername, OWNER_ACCESS_KEY_PREFIX } from '@/lib/registry';

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA';
type DnsRecord = { id: string; recordType: RecordType; recordName: string; content: string; ttl: number; proxied: boolean; priority: number | null; isPrimary: boolean };
type ManagedSubdomain = { id: string; label: string; parentDomain: string; status: string; records: DnsRecord[] };
type OwnerSession = {
  type: 'owner';
  owner: {
    // Kept only as the registration contact. The `telegram` value below is
    // the verified bot connection and is the only security/delivery channel.
    telegramUsername: string | null;
    telegram: {
      telegramUserId: string;
      username: string | null;
      displayName: string | null;
      linkedAt: number;
    } | null;
  };
  subdomains: Array<{ id: string; label: string; parentDomain: string; status: string }>;
};
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
type RecoveryStage = 'lookup' | 'send-code' | 'verify-code' | 'reset-key';

const proxyable = new Set<RecordType>(['A', 'AAAA', 'CNAME']);
const blankRecord = (): EditableRecord => ({ recordType: 'A', recordName: '@', content: '', ttl: 1, proxied: false, priority: '' });

function recordHost(label: string, parentDomain: string, name: string) {
  return name === '@' ? `${label}.${parentDomain}` : `${name}.${label}.${parentDomain}`;
}

function ttlLabel(ttl: number) {
  return ttl === 1 ? 'Auto' : `${ttl}s`;
}

function formatDate(timestamp: number, language: 'vi' | 'en') {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function normalizeAccessKeySuffix(value: string) {
  return value.replace(/^tk-/i, '').replace(/[^a-z0-9._-]/gi, '').slice(0, 29);
}

function normalizeRecoveryIdentifier(value: string) {
  const trimmed = value.trim();
  if (/^\d/.test(trimmed)) return trimmed.replace(/\D/g, '').slice(0, 20);
  return trimmed.replace(/^@/, '').replace(/[^a-z0-9_]/gi, '').slice(0, 32).toLowerCase();
}

function isValidRecoveryIdentifier(value: string) {
  return /^\d{1,20}$/.test(value) || isValidTelegramUsername(value);
}

export default function ManagePage() {
  const { language, setLanguage } = useUserLanguage();
  const [session, setSession] = useState<SessionData | null>(null);
  const [subdomains, setSubdomains] = useState<ManagedSubdomain[]>([]);
  const [accessKey, setAccessKey] = useState('');
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [accessKeyTouched, setAccessKeyTouched] = useState(false);
  const [loginKeyRejected, setLoginKeyRejected] = useState(false);
  const [accessKeyChangeOpen, setAccessKeyChangeOpen] = useState(false);
  const [currentAccessKeySuffix, setCurrentAccessKeySuffix] = useState('');
  const [newAccessKeySuffix, setNewAccessKeySuffix] = useState('');
  const [currentAccessKeyTouched, setCurrentAccessKeyTouched] = useState(false);
  const [newAccessKeyTouched, setNewAccessKeyTouched] = useState(false);
  const [currentAccessKeyRejected, setCurrentAccessKeyRejected] = useState(false);
  const [newAccessKeyRejected, setNewAccessKeyRejected] = useState(false);
  const [showCurrentAccessKey, setShowCurrentAccessKey] = useState(false);
  const [showNewAccessKey, setShowNewAccessKey] = useState(false);
  const [accessKeyChangeNotice, setAccessKeyChangeNotice] = useState<Notice>(null);
  const [selectedId, setSelectedId] = useState('');
  const [record, setRecord] = useState<EditableRecord>(blankRecord());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteVerificationCode, setDeleteVerificationCode] = useState('');
  const [deleteCodeSent, setDeleteCodeSent] = useState(false);
  const [deleteCodeExpiresAt, setDeleteCodeExpiresAt] = useState<number | null>(null);
  const [cancelRequestOpen, setCancelRequestOpen] = useState(false);
  const [cancelRequestConfirmation, setCancelRequestConfirmation] = useState('');
  const [telegramLinkUrl, setTelegramLinkUrl] = useState<string | null>(null);
  const [telegramLinkExpiresAt, setTelegramLinkExpiresAt] = useState<number | null>(null);
  const [telegramNotice, setTelegramNotice] = useState<Notice>(null);
  const [telegramUnlinkOpen, setTelegramUnlinkOpen] = useState(false);
  const [telegramUnlinkCodeSent, setTelegramUnlinkCodeSent] = useState(false);
  const [telegramUnlinkCode, setTelegramUnlinkCode] = useState('');
  const [telegramUnlinkExpiresAt, setTelegramUnlinkExpiresAt] = useState<number | null>(null);
  const [telegramUnlinkNotice, setTelegramUnlinkNotice] = useState<Notice>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryIdentifier, setRecoveryIdentifier] = useState('');
  const [recoveryIdentifierTouched, setRecoveryIdentifierTouched] = useState(false);
  const [recoveryStage, setRecoveryStage] = useState<RecoveryStage>('lookup');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryGrant, setRecoveryGrant] = useState('');
  const [recoveryKeySuffix, setRecoveryKeySuffix] = useState('');
  const [recoveryKeyTouched, setRecoveryKeyTouched] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<Notice>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [notice, setNotice] = useState<Notice>(null);
  useNoticeToast(notice);
  useNoticeToast(recoveryNotice);
  useNoticeToast(telegramNotice);
  useNoticeToast(telegramUnlinkNotice);
  useNoticeToast(accessKeyChangeNotice);

  const selected = useMemo(() => subdomains.find((item) => item.id === selectedId) ?? subdomains[0] ?? null, [selectedId, subdomains]);
  const primaryRecord = useMemo(() => selected?.records.find((item) => item.isPrimary) ?? null, [selected]);
  const secondaryRecords = useMemo(() => selected?.records.filter((item) => !item.isPrimary) ?? [], [selected]);
  const confirmationTarget = selected ? `${selected.label}.${selected.parentDomain}` : '';
  const accessKeyInvalid = accessKeyTouched && accessKey.trim().length > 0 && loginKeyRejected;
  const currentAccessKey = `${OWNER_ACCESS_KEY_PREFIX}${currentAccessKeySuffix}`;
  const newAccessKey = `${OWNER_ACCESS_KEY_PREFIX}${newAccessKeySuffix}`;
  const currentAccessKeyInvalid = (currentAccessKeyTouched && currentAccessKeySuffix.length > 0 && !isValidOwnerAccessKey(currentAccessKey)) || currentAccessKeyRejected;
  const newAccessKeyInvalid = (newAccessKeyTouched && newAccessKeySuffix.length > 0 && !isValidOwnerAccessKey(newAccessKey)) || newAccessKeyRejected;
  const recoveryIdentifierInvalid = recoveryIdentifierTouched && recoveryIdentifier.length > 0 && !isValidRecoveryIdentifier(recoveryIdentifier);
  const recoveryAccessKey = `${OWNER_ACCESS_KEY_PREFIX}${recoveryKeySuffix}`;
  const recoveryKeyInvalid = recoveryKeyTouched && recoveryKeySuffix.length > 0 && !isValidOwnerAccessKey(recoveryAccessKey);
  const t = <T,>(vi: T, en: T): T => language === 'en' ? en : vi;
  const date = (timestamp: number) => formatDate(timestamp, language);

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
      if (sessionPayload.owner.telegram) {
        setTelegramLinkUrl(null);
        setTelegramLinkExpiresAt(null);
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

  // A user usually completes /start in Telegram and then returns to this tab.
  // Poll only while a short-lived link is active, not permanently in the panel.
  useEffect(() => {
    if (!telegramLinkUrl || !session || session.type !== 'owner' || session.owner.telegram) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/manage/session', { cache: 'no-store' });
        if (!response.ok || stopped) return;
        const payload = await response.json() as SessionData;
        if (payload.type === 'owner' && payload.owner.telegram) {
          setSession(payload);
          setTelegramLinkUrl(null);
          setTelegramLinkExpiresAt(null);
          setTelegramNotice({ tone: 'success', text: 'Telegram đã được liên kết. Thông báo DNS và xác minh xóa subdomain đã sẵn sàng.' });
        }
      } catch {
        // The normal panel remains usable when a background refresh fails.
      }
    };
    const interval = window.setInterval(() => { void poll(); }, 4_000);
    void poll();
    return () => { stopped = true; window.clearInterval(interval); };
  }, [session, telegramLinkUrl]);

  useEffect(() => {
    if (!telegramLinkUrl || !telegramLinkExpiresAt) return;
    const remaining = telegramLinkExpiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      setTelegramLinkUrl(null);
      setTelegramLinkExpiresAt(null);
      setTelegramNotice({ tone: 'info', text: 'Link Telegram đã hết hạn. Bạn có thể tạo link mới.' });
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [telegramLinkExpiresAt, telegramLinkUrl]);

  useEffect(() => {
    if (!telegramUnlinkCodeSent || !telegramUnlinkExpiresAt) return;
    const remaining = telegramUnlinkExpiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      setTelegramUnlinkCode('');
      setTelegramUnlinkCodeSent(false);
      setTelegramUnlinkExpiresAt(null);
      setTelegramUnlinkNotice({ tone: 'info', text: 'Mã hủy liên kết đã hết hạn. Bạn có thể gửi mã mới.' });
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [telegramUnlinkExpiresAt, telegramUnlinkCodeSent]);

  useEffect(() => {
    if (!deleteCodeSent || !deleteCodeExpiresAt) return;
    const remaining = deleteCodeExpiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      setDeleteVerificationCode('');
      setDeleteCodeSent(false);
      setDeleteCodeExpiresAt(null);
      setNotice({ tone: 'info', text: 'Mã Telegram đã hết hạn. Hãy gửi mã mới để tiếp tục xóa.' });
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [deleteCodeExpiresAt, deleteCodeSent]);

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

  function resetRecovery() {
    setRecoveryIdentifier('');
    setRecoveryIdentifierTouched(false);
    setRecoveryStage('lookup');
    setRecoveryCode('');
    setRecoveryGrant('');
    setRecoveryKeySuffix('');
    setRecoveryKeyTouched(false);
    setShowRecoveryKey(false);
    setRecoveryNotice(null);
  }

  function toggleRecovery() {
    setRecoveryOpen((open) => {
      if (open) resetRecovery();
      return !open;
    });
  }

  async function lookupRecoveryIdentifier(event: FormEvent) {
    event.preventDefault();
    setRecoveryIdentifierTouched(true);
    if (!isValidRecoveryIdentifier(recoveryIdentifier)) {
      setRecoveryNotice({ tone: 'error', text: 'Nhập Telegram username đã liên kết hoặc Telegram ID dạng số.' });
      return;
    }
    setState('saving');
    setRecoveryNotice(null);
    try {
      const response = await fetch('/api/manage/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', identifier: recoveryIdentifier }),
      });
      const payload = await response.json() as { error?: string; linked?: boolean; message?: string };
      if (!response.ok || !payload.linked) {
        setRecoveryNotice({ tone: 'error', text: payload.error ?? payload.message ?? 'Không tìm thấy Telegram đã liên kết với DNS Panel.' });
        return;
      }
      setRecoveryStage('send-code');
      setRecoveryNotice({ tone: 'success', text: 'Đã tìm thấy Telegram đã xác minh. Gửi mã để tiếp tục.' });
    } catch {
      setRecoveryNotice({ tone: 'error', text: 'Không thể kiểm tra Telegram đã liên kết.' });
    } finally {
      setState('idle');
    }
  }

  async function sendRecoveryCode() {
    if (!isValidRecoveryIdentifier(recoveryIdentifier)) return;
    setState('saving');
    setRecoveryNotice(null);
    try {
      const response = await fetch('/api/manage/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send-code', identifier: recoveryIdentifier }),
      });
      const payload = await response.json() as { error?: string; expiresAt?: number };
      if (!response.ok) {
        setRecoveryNotice({ tone: 'error', text: payload.error ?? 'Không thể gửi mã khôi phục.' });
        return;
      }
      setRecoveryStage('verify-code');
      setRecoveryCode('');
      setRecoveryNotice({ tone: 'success', text: language === 'en' ? `Code sent through Telegram${payload.expiresAt ? `, expires ${date(payload.expiresAt)}` : ''}.` : `Mã đã được gửi qua Telegram${payload.expiresAt ? `, hết hạn ${date(payload.expiresAt)}` : ''}.` });
    } catch {
      setRecoveryNotice({ tone: 'error', text: 'Không thể kết nối để gửi mã khôi phục.' });
    } finally {
      setState('idle');
    }
  }

  async function verifyRecoveryCode(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(recoveryCode)) {
      setRecoveryNotice({ tone: 'error', text: 'Nhập đủ mã xác minh gồm 6 số.' });
      return;
    }
    setState('saving');
    setRecoveryNotice(null);
    try {
      const response = await fetch('/api/manage/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-code', identifier: recoveryIdentifier, code: recoveryCode }),
      });
      const payload = await response.json() as { error?: string; grant?: string };
      if (!response.ok || !payload.grant) {
        setRecoveryNotice({ tone: 'error', text: payload.error ?? 'Mã xác minh không đúng hoặc đã hết hạn.' });
        return;
      }
      setRecoveryGrant(payload.grant);
      setRecoveryCode('');
      setRecoveryStage('reset-key');
      setRecoveryNotice({ tone: 'success', text: 'Telegram đã xác minh. Bây giờ hãy đặt access key mới.' });
    } catch {
      setRecoveryNotice({ tone: 'error', text: 'Không thể xác minh mã khôi phục.' });
    } finally {
      setState('idle');
    }
  }

  async function recoverAccessKey(event: FormEvent) {
    event.preventDefault();
    setRecoveryKeyTouched(true);
    if (!recoveryGrant || !isValidOwnerAccessKey(recoveryAccessKey)) {
      setRecoveryNotice({ tone: 'error', text: 'Đặt access key mới hợp lệ trước khi tiếp tục.' });
      return;
    }
    setState('saving');
    setRecoveryNotice(null);
    try {
      const response = await fetch('/api/manage/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reset-access-key',
          identifier: recoveryIdentifier,
          grant: recoveryGrant,
          newAccessKey: recoveryAccessKey,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setRecoveryNotice({ tone: 'error', text: payload.error ?? 'Không thể khôi phục access key.' });
        return;
      }
      setRecoveryOpen(false);
      resetRecovery();
      await loadPanel();
      setNotice({ tone: 'success', text: 'Access key mới đã được lưu. Các phiên DNS Panel cũ đã được đăng xuất.' });
    } catch {
      setRecoveryNotice({ tone: 'error', text: 'Không thể kết nối để khôi phục access key.' });
    } finally {
      setState('idle');
    }
  }

  async function createTelegramLink() {
    if (!session || session.type !== 'owner' || session.owner.telegram) return;
    // Open the tab synchronously while this still counts as a direct user gesture.
    // If a browser blocks it, the compact fallback link below remains available.
    const botWindow = window.open('about:blank', '_blank');
    setState('saving');
    setTelegramNotice(null);
    try {
      const response = await fetch('/api/manage/telegram-link', { method: 'POST' });
      const payload = await response.json() as { error?: string; url?: string; expiresAt?: number };
      if (!response.ok || !payload.url || !payload.expiresAt) {
        botWindow?.close();
        setTelegramNotice({ tone: 'error', text: payload.error ?? 'Không thể tạo link Telegram.' });
        if (response.status === 409) await loadPanel();
        return;
      }
      setTelegramLinkUrl(payload.url);
      setTelegramLinkExpiresAt(payload.expiresAt);
      if (botWindow) {
        botWindow.opener = null;
        botWindow.location.replace(payload.url);
      }
      setTelegramNotice({ tone: 'info', text: botWindow ? 'Bot đã được mở. Bấm Start rồi quay lại trang này.' : 'Trình duyệt chặn tab mới. Hãy dùng link mở bot bên dưới.' });
    } catch {
      botWindow?.close();
      setTelegramNotice({ tone: 'error', text: 'Không thể kết nối để tạo link Telegram.' });
    } finally {
      setState('idle');
    }
  }

  function resetTelegramUnlink() {
    setTelegramUnlinkOpen(false);
    setTelegramUnlinkCodeSent(false);
    setTelegramUnlinkCode('');
    setTelegramUnlinkExpiresAt(null);
    setTelegramUnlinkNotice(null);
  }

  async function sendTelegramUnlinkCode() {
    if (!session || session.type !== 'owner' || !session.owner.telegram) return;
    setState('saving');
    setTelegramUnlinkNotice(null);
    try {
      const response = await fetch('/api/manage/telegram-link', {
        method: 'PATCH',
      });
      const payload = await response.json() as { error?: string; expiresAt?: number };
      if (!response.ok) {
        setTelegramUnlinkNotice({ tone: 'error', text: payload.error ?? 'Không thể gửi mã xác nhận.' });
        return;
      }
      setTelegramUnlinkCode('');
      setTelegramUnlinkCodeSent(true);
      setTelegramUnlinkExpiresAt(payload.expiresAt ?? null);
      setTelegramUnlinkNotice({ tone: 'success', text: language === 'en' ? `Confirmation code sent through Telegram${payload.expiresAt ? `, expires ${date(payload.expiresAt)}` : ''}.` : `Mã xác nhận đã gửi qua Telegram${payload.expiresAt ? `, hết hạn ${date(payload.expiresAt)}` : ''}.` });
    } catch {
      setTelegramUnlinkNotice({ tone: 'error', text: 'Không thể kết nối để gửi mã xác nhận.' });
    } finally {
      setState('idle');
    }
  }

  async function confirmTelegramUnlink(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(telegramUnlinkCode)) {
      setTelegramUnlinkNotice({ tone: 'error', text: 'Nhập đủ mã xác nhận gồm 6 số.' });
      return;
    }
    setState('saving');
    setTelegramUnlinkNotice(null);
    try {
      const response = await fetch('/api/manage/telegram-link', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: telegramUnlinkCode }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setTelegramUnlinkNotice({ tone: 'error', text: payload.error ?? 'Mã xác nhận không đúng hoặc đã hết hạn.' });
        return;
      }
      resetTelegramUnlink();
      await loadPanel();
      setTelegramNotice({ tone: 'success', text: 'Đã hủy liên kết Telegram. Thông báo bot và xác minh Telegram đã tắt.' });
    } catch {
      setTelegramUnlinkNotice({ tone: 'error', text: 'Không thể hủy liên kết Telegram.' });
    } finally {
      setState('idle');
    }
  }

  function resetForm() {
    setRecord(blankRecord());
    setEditingId(null);
  }

  function editRecord(item: DnsRecord) {
    setDeletePanelOpen(false);
    setDeleteConfirmation('');
    resetDeleteVerification();
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
    if (!selected || !window.confirm(`Xóa ${item.recordType} ${item.recordName} khỏi ${selected.label}.${selected.parentDomain}?`)) return;
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

  function resetDeleteVerification() {
    setDeleteVerificationCode('');
    setDeleteCodeSent(false);
    setDeleteCodeExpiresAt(null);
  }

  async function requestDeleteVerificationCode() {
    if (!selected || !session || session.type !== 'owner' || !session.owner.telegram || deleteConfirmation !== confirmationTarget) return;
    setState('saving');
    setNotice(null);
    try {
      const response = await fetch('/api/manage/subdomains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomainId: selected.id, confirmation: deleteConfirmation }),
      });
      const payload = await response.json() as { error?: string; otpRequired?: boolean; expiresAt?: number };
      if (!response.ok) {
        setNotice({ tone: 'error', text: payload.error ?? 'Không thể gửi mã xác minh.' });
        return;
      }
      if (!payload.otpRequired) {
        await loadPanel();
        setNotice({ tone: 'info', text: 'Telegram chưa còn liên kết. Hãy mở lại vùng xóa để xác nhận theo cách thường.' });
        return;
      }
      setDeleteCodeSent(true);
      setDeleteCodeExpiresAt(payload.expiresAt ?? null);
      setDeleteVerificationCode('');
      setNotice({ tone: 'success', text: 'Mã xác minh đã được gửi vào Telegram liên kết. Mã chỉ dùng một lần.' });
    } catch {
      setNotice({ tone: 'error', text: 'Không thể kết nối để gửi mã xác minh.' });
    } finally {
      setState('idle');
    }
  }

  async function deleteSubdomain(event: FormEvent) {
    event.preventDefault();
    if (!selected || deleteConfirmation !== confirmationTarget) return;
    const telegramLinked = session?.type === 'owner' && Boolean(session.owner.telegram);
    if (telegramLinked && !deleteCodeSent) {
      await requestDeleteVerificationCode();
      return;
    }
    if (telegramLinked && !/^\d{6}$/.test(deleteVerificationCode)) {
      setNotice({ tone: 'error', text: 'Nhập mã 6 số đã gửi tới Telegram trước khi xóa.' });
      return;
    }
    setState('saving');
    setNotice(null);
    try {
    const response = await fetch('/api/manage/subdomains', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subdomainId: selected.id,
        confirmation: deleteConfirmation,
        ...(telegramLinked ? { code: deleteVerificationCode } : {}),
      }),
    });
    const payload = await response.json() as { error?: string; ownerDeleted?: boolean; hostname?: string };
    if (!response.ok) {
      setState('idle');
      setNotice({ tone: 'error', text: payload.error ?? 'Không thể xóa subdomain.' });
      return;
    }
    resetForm();
    setDeleteConfirmation('');
    resetDeleteVerification();
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
    } catch {
      setState('idle');
      setNotice({ tone: 'error', text: 'Không thể kết nối để xóa subdomain.' });
    }
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

  function resetAccessKeyChange() {
    setCurrentAccessKeySuffix('');
    setNewAccessKeySuffix('');
    setCurrentAccessKeyTouched(false);
    setNewAccessKeyTouched(false);
    setCurrentAccessKeyRejected(false);
    setNewAccessKeyRejected(false);
    setShowCurrentAccessKey(false);
    setShowNewAccessKey(false);
  }

  function openAccessKeyChange() {
    resetAccessKeyChange();
    setAccessKeyChangeOpen(true);
    setAccessKeyChangeNotice(null);
    setNotice(null);
  }

  function closeAccessKeyChange() {
    if (state === 'saving') return;
    setAccessKeyChangeOpen(false);
    resetAccessKeyChange();
    setAccessKeyChangeNotice(null);
  }

  async function changeAccessKey(event: FormEvent) {
    event.preventDefault();
    setCurrentAccessKeyTouched(true);
    setNewAccessKeyTouched(true);
    setCurrentAccessKeyRejected(false);
    setNewAccessKeyRejected(false);

    if (!currentAccessKeySuffix || !newAccessKeySuffix) {
      setAccessKeyChangeNotice({ tone: 'error', text: 'Nhập cả access key hiện tại và access key mới.' });
      return;
    }
    if (!isValidOwnerAccessKey(currentAccessKey) || !isValidOwnerAccessKey(newAccessKey)) {
      setAccessKeyChangeNotice({ tone: 'error', text: 'Phần sau tk- phải dài 11–29 ký tự, có cả chữ và số; chỉ dùng thêm . _ - khi cần.' });
      return;
    }
    if (currentAccessKey === newAccessKey) {
      setNewAccessKeyRejected(true);
      setAccessKeyChangeNotice({ tone: 'error', text: 'Access key mới phải khác access key hiện tại.' });
      return;
    }

    setState('saving');
    setAccessKeyChangeNotice(null);
    try {
      const response = await fetch('/api/manage/access-key', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentAccessKey, newAccessKey }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 401) setCurrentAccessKeyRejected(true);
        if (response.status === 409) setNewAccessKeyRejected(true);
        setState('idle');
        setAccessKeyChangeNotice({ tone: 'error', text: payload.error ?? 'Không thể đổi access key.' });
        return;
      }

      resetAccessKeyChange();
      await loadPanel();
      setAccessKeyChangeNotice({ tone: 'success', text: 'Đã đổi access key. Các phiên DNS Panel khác đã được đăng xuất.' });
    } catch {
      setState('idle');
      setAccessKeyChangeNotice({ tone: 'error', text: 'Không thể kết nối để đổi access key. Hãy thử lại.' });
    }
  }

  function renderAccessKeyChangePanel() {
    return (
      <section className="panel access-key-change-panel" aria-labelledby="access-key-change-heading">
        <div className="access-key-change-heading">
          <div>
            <p className="eyebrow"><span className="pixel-dot" /> SECURITY</p>
            <h2 id="access-key-change-heading">{t('Đổi access key', 'Change access key')}</h2>
          </div>
          <button className="text-button" type="button" onClick={closeAccessKeyChange} disabled={state === 'saving'}>{t('Đóng', 'Close')}</button>
        </div>
        <p className="access-key-change-copy">{t('Phiên hiện tại vẫn được giữ. Tất cả phiên DNS Panel khác sẽ bị đăng xuất sau khi đổi key.', 'This session stays active. Every other DNS Panel session will be signed out after the key changes.')}</p>
        <form noValidate onSubmit={changeAccessKey}>
          <div className="form-pair">
            <label htmlFor="current-access-key">{t('Access key hiện tại', 'Current access key')}
              <div className={`field-combo access-key-combo${currentAccessKeyInvalid ? ' invalid' : ''}`}>
                <b>{OWNER_ACCESS_KEY_PREFIX}</b>
                <input id="current-access-key" type={showCurrentAccessKey ? 'text' : 'password'} placeholder="your-current-key" value={currentAccessKeySuffix} onChange={(event) => { setCurrentAccessKeySuffix(normalizeAccessKeySuffix(event.target.value)); setCurrentAccessKeyTouched(false); setCurrentAccessKeyRejected(false); setAccessKeyChangeNotice(null); }} onBlur={() => setCurrentAccessKeyTouched(true)} autoComplete="off" required />
                <HoldToRevealButton label={t('access key hiện tại', 'current access key')} onRevealChange={setShowCurrentAccessKey} />
              </div>
              {currentAccessKeyInvalid && <small className="field-bad">{t('Access key hiện tại không đúng.', 'The current access key is incorrect.')}</small>}
            </label>
            <label htmlFor="new-access-key">{t('Access key mới', 'New access key')}
              <div className={`field-combo access-key-combo${newAccessKeyInvalid ? ' invalid' : ''}`}>
                <b>{OWNER_ACCESS_KEY_PREFIX}</b>
                <input id="new-access-key" type={showNewAccessKey ? 'text' : 'password'} placeholder="your-new-key" value={newAccessKeySuffix} onChange={(event) => { setNewAccessKeySuffix(normalizeAccessKeySuffix(event.target.value)); setNewAccessKeyTouched(false); setNewAccessKeyRejected(false); setAccessKeyChangeNotice(null); }} onBlur={() => setNewAccessKeyTouched(true)} autoComplete="new-password" required />
                <HoldToRevealButton label={t('access key mới', 'new access key')} onRevealChange={setShowNewAccessKey} />
              </div>
              {newAccessKeyInvalid && <small className="field-bad">{t('Dùng 11–29 ký tự, có cả chữ và số; chỉ thêm . _ - khi cần.', 'Use 11–29 characters with letters and numbers; . _ - are optional.')}</small>}
            </label>
          </div>
          <div className="editor-actions access-key-change-actions">
            <button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang đổi...', 'Changing...') : t('Đổi access key', 'Change access key')}</button>
            <button className="button cancel" type="button" onClick={closeAccessKeyChange} disabled={state === 'saving'}>{t('Hủy', 'Cancel')}</button>
          </div>
        </form>
      </section>
    );
  }

  async function logout() {
    await fetch('/api/manage/session', { method: 'DELETE' });
    setSession(null);
    setSubdomains([]);
    setSelectedId('');
    resetForm();
    setDeletePanelOpen(false);
    setDeleteConfirmation('');
    resetDeleteVerification();
    setCancelRequestOpen(false);
    setAccessKeyChangeOpen(false);
    resetAccessKeyChange();
    setAccessKeyChangeNotice(null);
    setTelegramLinkUrl(null);
    setTelegramLinkExpiresAt(null);
    setTelegramNotice(null);
    resetTelegramUnlink();
    resetRecovery();
    setNotice(null);
  }

  if (!session) {
    return (
      <main className="manage-page">
        <div className="manage-shell narrow-shell">
          <header className="manage-header"><Link href="/" className="back-link">← {t('Về trang đăng ký', 'Back to registration')}</Link><UserLanguageToggle language={language} onChange={setLanguage} /></header>
          <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>{t('Nhập access key bạn đã tự đặt khi đăng ký. Key chỉ tạo phiên trên thiết bị này.', 'Enter the access key you chose during registration. It creates a session only on this device.')}</p></div>
          <form className="panel access-form" noValidate onSubmit={login}>
            <label htmlFor="owner-key">Owner access key
              <div className={`field-combo access-key-combo owner-key-combo${accessKeyInvalid ? ' invalid' : ''}`}>
                <input id="owner-key" type={showAccessKey ? 'text' : 'password'} placeholder="tk-your-access-key" value={accessKey} onChange={(event) => { setAccessKey(event.target.value); setAccessKeyTouched(false); setLoginKeyRejected(false); setNotice(null); }} onBlur={() => setAccessKeyTouched(true)} autoComplete="off" required />
                <HoldToRevealButton label="access key" onRevealChange={setShowAccessKey} />
              </div>
            </label>
            {accessKeyInvalid && <small className="field-bad access-key-feedback">{t('Nhập đầy đủ access key, gồm cả tiền tố tk-.', 'Enter the complete access key, including the tk- prefix.')}</small>}
            <button className="lost-key-link" type="button" onClick={toggleRecovery}>{t('Quên hoặc mất access key?', 'Forgot or lost your access key?')}</button>
            <button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang mở...', 'Opening...') : t('Mở DNS panel', 'Open DNS panel')}</button>
          </form>
          {recoveryOpen && <section className="panel recovery-panel" aria-labelledby="recovery-heading">
            <div className="access-key-change-heading">
              <div><p className="eyebrow"><span className="pixel-dot" /> TELEGRAM RECOVERY</p><h2 id="recovery-heading">{t('Khôi phục access key', 'Recover access key')}</h2></div>
              <button className="text-button" type="button" onClick={toggleRecovery} disabled={state === 'saving'}>{t('Đóng', 'Close')}</button>
            </div>
            <p className="access-key-change-copy">{t('Chỉ dùng được khi bạn đã liên kết Telegram bot với DNS Panel. Bot gửi mã riêng vào đúng tài khoản đã liên kết.', 'This works only after you have linked the Telegram bot to DNS Panel. The bot sends a private code to that linked account.')}</p>
            {recoveryStage === 'lookup' && <form noValidate onSubmit={lookupRecoveryIdentifier}>
              <label htmlFor="recovery-telegram">{t('Telegram username hoặc ID đã liên kết', 'Linked Telegram username or ID')}
                <input id="recovery-telegram" className={`field${recoveryIdentifierInvalid ? ' invalid' : recoveryIdentifierTouched && recoveryIdentifier ? ' valid' : ''}`} value={recoveryIdentifier} onChange={(event) => { setRecoveryIdentifier(normalizeRecoveryIdentifier(event.target.value)); setRecoveryIdentifierTouched(false); setRecoveryNotice(null); }} onBlur={() => setRecoveryIdentifierTouched(true)} placeholder="@your_telegram hoặc 123456789" autoComplete="username" required />
              </label>
              {recoveryIdentifierInvalid && <small className="field-bad">{t('Nhập username Telegram hoặc Telegram ID dạng số.', 'Enter a Telegram username or numeric Telegram ID.')}</small>}
              <div className="editor-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang kiểm tra...', 'Checking...') : t('Kiểm tra Telegram', 'Check Telegram')}</button></div>
            </form>}
            {recoveryStage === 'send-code' && <div className="recovery-step">
              <p className="recovery-identifier">{t('Telegram đã xác minh:', 'Verified Telegram:')} <strong>{/^\d+$/.test(recoveryIdentifier) ? `ID ${recoveryIdentifier}` : `@${recoveryIdentifier}`}</strong></p>
              <div className="editor-actions recovery-actions"><button className="button" type="button" onClick={() => void sendRecoveryCode()} disabled={state !== 'idle'}>{state === 'saving' ? t('Đang gửi...', 'Sending...') : t('Gửi mã qua Telegram', 'Send code via Telegram')}</button><button className="button secondary-action" type="button" onClick={() => { setRecoveryStage('lookup'); setRecoveryNotice(null); }} disabled={state === 'saving'}>{t('Nhập lại', 'Enter again')}</button></div>
            </div>}
            {recoveryStage === 'verify-code' && <form noValidate onSubmit={verifyRecoveryCode}>
              <label htmlFor="recovery-code">{t('Mã từ Telegram', 'Code from Telegram')}
                <input id="recovery-code" className="field recovery-code" value={recoveryCode} onChange={(event) => { setRecoveryCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setRecoveryNotice(null); }} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
              </label>
              <div className="editor-actions recovery-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang xác minh...', 'Verifying...') : t('Xác minh mã', 'Verify code')}</button><button className="button secondary-action" type="button" onClick={() => void sendRecoveryCode()} disabled={state !== 'idle'}>{t('Gửi lại mã', 'Send code again')}</button></div>
            </form>}
            {recoveryStage === 'reset-key' && <form noValidate onSubmit={recoverAccessKey}>
              <label htmlFor="recovery-access-key">{t('Access key mới', 'New access key')}
                <div className={`field-combo access-key-combo${recoveryKeyInvalid ? ' invalid' : recoveryKeyTouched && recoveryKeySuffix ? ' valid' : ''}`}>
                  <b>{OWNER_ACCESS_KEY_PREFIX}</b>
                  <input id="recovery-access-key" type={showRecoveryKey ? 'text' : 'password'} placeholder="your-new-key" value={recoveryKeySuffix} onChange={(event) => { setRecoveryKeySuffix(normalizeAccessKeySuffix(event.target.value)); setRecoveryKeyTouched(false); setRecoveryNotice(null); }} onBlur={() => setRecoveryKeyTouched(true)} autoComplete="new-password" required />
                  <HoldToRevealButton label={t('access key mới', 'new access key')} onRevealChange={setShowRecoveryKey} />
                </div>
              </label>
              {recoveryKeyInvalid && <small className="field-bad">{t('Dùng 11–29 ký tự, có cả chữ và số; chỉ thêm . _ - khi cần.', 'Use 11–29 characters with letters and numbers; . _ - are optional.')}</small>}
              <div className="editor-actions recovery-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang khôi phục...', 'Recovering...') : t('Đặt access key mới', 'Set new access key')}</button><button className="button secondary-action" type="button" onClick={resetRecovery} disabled={state === 'saving'}>{t('Bắt đầu lại', 'Start over')}</button></div>
            </form>}
            <p className="lost-key-help">{t('Bạn chưa từng liên kết bot?', 'Never linked the bot?')} <a href="https://t.me/jinndesu" target="_blank" rel="noreferrer">{t('Liên hệ Admin', 'Contact Admin')}</a>.</p>
          </section>}
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
          <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><div className="manage-header-actions"><UserLanguageToggle language={language} onChange={setLanguage} /><button className="text-button" type="button" onClick={logout}>{t('Đăng xuất', 'Sign out')}</button></div></header>
          <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> REQUEST STATUS</p><h1>{isPending ? t('Đang chờ duyệt', 'Awaiting review') : t('Yêu cầu đã từ chối', 'Request declined')}</h1></div><p>{isPending ? t('Access key của bạn đã được xác thực, nhưng DNS sẽ chỉ mở sau khi admin duyệt yêu cầu.', 'Your access key is verified, but DNS opens only after an admin approves the request.') : t('Bạn có thể xem lại thông tin bên dưới hoặc gửi một yêu cầu mới.', 'Review the details below or submit a new request.')}</p></div>
          <section className={`panel pending-request-panel${isPending ? '' : ' rejected-request-panel'}`}>
            <div className="pending-request-head"><div><p className="eyebrow"><span className="pixel-dot" /> {isPending ? 'WAITING FOR REVIEW' : 'REQUEST CLOSED'}</p><h2>{request.hostname}</h2></div><span className={`status ${isPending ? 'pending' : 'rejected'}`}>{isPending ? 'pending' : 'rejected'}</span></div>
            <div className="request-details pending-request-details"><div>CNAME<strong>{request.cnameTarget}</strong></div><div>Telegram<strong>{request.telegramUsername ? `@${request.telegramUsername}` : t('Không có', 'None')}</strong></div><div>{t('Gửi lúc', 'Sent')}<strong>{date(request.createdAt)}</strong></div></div>
            {request.reviewerNote && <p className="note">{t('Lý do từ chối từ admin:', 'Reason from admin:')} {request.reviewerNote}</p>}
            {isPending ? <><p className="pending-copy">{t('Chưa có DNS record nào được tạo và bạn chưa thể sửa DNS trong lúc chờ. Nếu admin vừa duyệt, hãy tải lại trạng thái để mở panel ngay.', 'No DNS records have been created and DNS cannot be edited while awaiting review. If an admin just approved it, refresh this status to open the panel.')}</p><div className="editor-actions pending-actions"><button type="button" className="button secondary-action" onClick={() => void refreshRequestStatus()} disabled={state !== 'idle'}>{state === 'loading' ? t('Đang kiểm tra...', 'Checking...') : t('Tải lại trạng thái', 'Refresh status')}</button><button type="button" className="button reject" onClick={() => { setCancelRequestOpen((open) => !open); setCancelRequestConfirmation(''); }}>{t('Hủy yêu cầu', 'Cancel request')}</button></div></> : <div className="pending-actions"><Link className="button secondary-action" href="/">{t('Gửi yêu cầu mới', 'Send a new request')}</Link></div>}
          </section>
          {isPending && cancelRequestOpen && <section className="panel cancel-request-panel"><p className="eyebrow"><span className="pixel-dot" /> CONFIRM CANCELLATION</p><h2>{t('Hủy', 'Cancel')} {request.hostname}</h2><p>{t('Yêu cầu sẽ được lưu lại trong lịch sử là “đã tự hủy”; không có DNS nào bị xóa vì DNS chưa được tạo. Tên này sẽ có thể đăng ký lại.', 'The request remains in history as “cancelled by user”; no DNS is deleted because none has been created. This name can be registered again.')}</p><form onSubmit={cancelRequest}><label htmlFor="cancel-request-confirm">{t('Nhập chính xác', 'Type exactly')} <code>{request.hostname}</code><input id="cancel-request-confirm" className="field" value={cancelRequestConfirmation} onChange={(event) => setCancelRequestConfirmation(event.target.value)} autoComplete="off" placeholder={request.hostname} required /></label><div className="editor-actions"><button className="button destructive" type="submit" disabled={state !== 'idle' || cancelRequestConfirmation !== request.hostname}>{state === 'saving' ? t('Đang hủy...', 'Cancelling...') : t('Tôi hiểu, hủy yêu cầu', 'I understand, cancel request')}</button><button type="button" className="button cancel" onClick={() => { setCancelRequestOpen(false); setCancelRequestConfirmation(''); }}>{t('Quay lại', 'Back')}</button></div></form></section>}
        </div>
      </main>
    );
  }

  return <main className="manage-page"><div className="manage-shell">
    <header className="manage-header"><Link href="/" className="back-link">← Takeshi Domains</Link><div className="manage-header-actions"><UserLanguageToggle language={language} onChange={setLanguage} />{session.owner.telegram ? <button className="text-button" type="button" onClick={() => { if (telegramUnlinkOpen) resetTelegramUnlink(); else { setTelegramUnlinkOpen(true); setTelegramUnlinkNotice(null); } }} disabled={state === 'saving'}>{t('Hủy liên kết Telegram', 'Unlink Telegram')}</button> : <button className="text-button" type="button" onClick={() => void createTelegramLink()} disabled={state === 'saving'}>{state === 'saving' ? t('Đang mở bot...', 'Opening bot...') : t('Liên kết Telegram', 'Link Telegram')}</button>}<button className="text-button" type="button" onClick={openAccessKeyChange} disabled={state === 'saving'}>{t('Đổi access key', 'Change access key')}</button><button className="text-button" type="button" onClick={logout}>{t('Đăng xuất', 'Sign out')}</button></div></header>
    <div className="manage-heading"><div><p className="eyebrow"><span className="pixel-dot" /> OWNER CONSOLE</p><h1>DNS panel</h1></div><p>{session.owner.telegram ? <><span className="verified-telegram"><strong>{t('Telegram đã xác minh:', 'Verified Telegram:')}</strong> {session.owner.telegram.displayName ?? t('Tài khoản Telegram', 'Telegram account')}{session.owner.telegram.username ? ` · @${session.owner.telegram.username}` : ''} · ID {session.owner.telegram.telegramUserId}</span>{t('Bot sẽ báo các thay đổi DNS và gửi mã xác minh khi cần.', 'The bot will notify you about DNS changes and send verification codes when needed.')}</> : <>{session.owner.telegramUsername ? t(`Telegram khi đăng ký: @${session.owner.telegramUsername}`, `Registration Telegram: @${session.owner.telegramUsername}`) : t('Telegram chưa liên kết', 'Telegram is not linked')}<br />{t('Liên kết bot để nhận thông báo DNS và tăng bảo mật.', 'Link the bot to receive DNS notifications and increase security.')}</>}<br />{t('Chỉ các record thuộc subdomain của bạn mới hiển thị ở đây.', 'Only records under your own subdomain are shown here.')}</p></div>
    {((!session.owner.telegram && telegramLinkUrl) || telegramNotice) && <div className="telegram-link-fallback">
      {telegramLinkUrl && <>{t('Nếu Telegram chưa tự mở:', 'If Telegram did not open:')} <a href={telegramLinkUrl} target="_blank" rel="noreferrer">{t('Mở bot', 'Open bot')}</a>{telegramLinkExpiresAt ? t(` · link hết hạn ${date(telegramLinkExpiresAt)}`, ` · link expires ${date(telegramLinkExpiresAt)}`) : ''}.</>}
    </div>}
    {telegramUnlinkOpen && session.owner.telegram && <section className="panel telegram-unlink-panel" aria-labelledby="telegram-unlink-heading">
      <div className="access-key-change-heading"><div><p className="eyebrow"><span className="pixel-dot" /> TELEGRAM SECURITY</p><h2 id="telegram-unlink-heading">{t('Hủy liên kết Telegram', 'Unlink Telegram')}</h2></div><button className="text-button" type="button" onClick={resetTelegramUnlink} disabled={state === 'saving'}>{t('Đóng', 'Close')}</button></div>
      {!telegramUnlinkCodeSent ? <><p className="access-key-change-copy">{t('Bot sẽ gửi mã xác nhận tới Telegram đang liên kết trước khi hủy. Sau đó bạn sẽ không còn nhận thông báo DNS hay dùng Telegram để xác minh xóa subdomain.', 'The bot will send a confirmation code to the linked Telegram before unlinking. Afterwards you will not receive DNS notifications or use Telegram to verify subdomain deletion.')}</p><div className="editor-actions"><button className="button destructive" type="button" onClick={() => void sendTelegramUnlinkCode()} disabled={state !== 'idle'}>{state === 'saving' ? t('Đang gửi...', 'Sending...') : t('Gửi mã xác nhận', 'Send confirmation code')}</button><button className="button cancel" type="button" onClick={resetTelegramUnlink} disabled={state === 'saving'}>{t('Hủy', 'Cancel')}</button></div></> : <form noValidate onSubmit={confirmTelegramUnlink}><label htmlFor="telegram-unlink-code">{t('Mã từ Telegram', 'Code from Telegram')}<input id="telegram-unlink-code" className="field recovery-code" value={telegramUnlinkCode} onChange={(event) => { setTelegramUnlinkCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setTelegramUnlinkNotice(null); }} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required /></label><div className="editor-actions"><button className="button destructive" type="submit" disabled={state !== 'idle' || !/^\d{6}$/.test(telegramUnlinkCode)}>{state === 'saving' ? t('Đang hủy...', 'Unlinking...') : t('Xác nhận hủy liên kết', 'Confirm unlink')}</button><button className="button secondary-action" type="button" onClick={() => void sendTelegramUnlinkCode()} disabled={state !== 'idle'}>{t('Gửi lại mã', 'Send code again')}</button><button className="button cancel" type="button" onClick={resetTelegramUnlink} disabled={state === 'saving'}>{t('Hủy', 'Cancel')}</button></div></form>}
    </section>}
    {accessKeyChangeOpen && renderAccessKeyChangePanel()}
    {subdomains.length === 0 ? <><div className="panel empty-state">{t('Chưa có subdomain active cho access key này.', 'There is no active subdomain for this access key yet.')}</div></> : <>
      <div className="domain-tabs" role="tablist">{subdomains.map((domain) => <button type="button" key={domain.id} className={domain.id === selected?.id ? 'domain-tab active' : 'domain-tab'} onClick={() => { setSelectedId(domain.id); resetForm(); setDeletePanelOpen(false); setDeleteConfirmation(''); resetDeleteVerification(); }}>{domain.label}.{domain.parentDomain}</button>)}</div>
      {selected && <>
        <section className="panel primary-domain-panel"><div className="primary-domain-heading"><div><p className="eyebrow"><span className="pixel-dot" /> PRIMARY SUBDOMAIN</p><h2>{selected.label}<span>.{selected.parentDomain}</span></h2><p>{t('Đây là subdomain bạn đã đăng ký. Record chính luôn được ghim ở đây.', 'This is the subdomain you registered. Its primary record is always pinned here.')}</p></div><span className="status active">PRIMARY</span></div>{primaryRecord ? <div className="primary-record-summary"><span className="record-type">{primaryRecord.recordType}</span><div><strong>{recordHost(selected.label, selected.parentDomain, primaryRecord.recordName)}</strong><code>{primaryRecord.content}</code><small>{ttlLabel(primaryRecord.ttl)}{primaryRecord.proxied ? ' · proxied' : ' · DNS only'}</small></div><div className="primary-record-actions"><button className="icon-action" type="button" onClick={() => editRecord(primaryRecord)} aria-label={t('Sửa record chính', 'Edit primary record')} title={t('Sửa record chính', 'Edit primary record')}>✎</button><button className="icon-action destructive-icon" type="button" onClick={() => { setDeletePanelOpen((open) => !open); setDeleteConfirmation(''); resetDeleteVerification(); }} aria-label={t('Xóa toàn bộ subdomain', 'Delete entire subdomain')} title={t('Xóa toàn bộ subdomain', 'Delete entire subdomain')}>×</button></div></div> : <p className="empty-copy">{t('Không tìm thấy record chính. Hãy liên hệ admin.', 'Primary record not found. Please contact the admin.')}</p>}</section>
        {deletePanelOpen && <section className="panel delete-subdomain-panel">
          <p className="eyebrow"><span className="pixel-dot" /> DANGER ZONE</p>
          <h2>{t('Xóa', 'Delete')} {confirmationTarget}</h2>
          <p>{t('Thao tác này xóa toàn bộ DNS records và quyền panel của subdomain. Lịch sử đăng ký vẫn được giữ lại, còn tên sẽ trở về trạng thái có thể đăng ký.', 'This deletes every DNS record and panel access for this subdomain. The registration history remains, and the name becomes available again.')}</p>
          <form noValidate onSubmit={deleteSubdomain}>
            <label htmlFor="delete-confirm">{t('Nhập chính xác', 'Type exactly')} <code>{confirmationTarget}</code>
              <input id="delete-confirm" className="field" value={deleteConfirmation} onChange={(event) => { setDeleteConfirmation(event.target.value); resetDeleteVerification(); }} autoComplete="off" placeholder={confirmationTarget} required />
            </label>
            {session.owner.telegram ? <div className="delete-telegram-verification">
              <p><strong>{t('Xác minh Telegram', 'Telegram verification')}</strong><span>{t('Mã sẽ gửi tới Telegram đã liên kết sau khi hostname đúng.', 'A code will be sent to linked Telegram once the hostname matches.')}</span></p>
              {deleteCodeSent && <label htmlFor="delete-telegram-code">{t('Mã Telegram', 'Telegram code')}
                <input id="delete-telegram-code" className="field recovery-code" value={deleteVerificationCode} onChange={(event) => setDeleteVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
              </label>}
              {deleteCodeSent && <small>{t(`Mã dùng một lần${deleteCodeExpiresAt ? ` · hết hạn ${date(deleteCodeExpiresAt)}` : ''}. Không nhận được? Bạn có thể gửi lại mã.`, `One-time code${deleteCodeExpiresAt ? ` · expires ${date(deleteCodeExpiresAt)}` : ''}. Did not receive it? You can send it again.`)}</small>}
            </div> : <p className="delete-no-telegram">{t('Bạn chưa liên kết Telegram nên thao tác này chỉ được bảo vệ bằng hostname xác nhận. Bạn có thể liên kết bot ở đầu panel để tăng bảo mật.', 'Telegram is not linked, so this action is protected only by hostname confirmation. Link the bot at the top of this panel for stronger security.')}</p>}
            <div className="editor-actions">
              <button className="button destructive" type="submit" disabled={state !== 'idle' || deleteConfirmation !== confirmationTarget || (Boolean(session.owner.telegram) && deleteCodeSent && !/^\d{6}$/.test(deleteVerificationCode))}>{state === 'saving' ? t('Đang xử lý...', 'Processing...') : session.owner.telegram ? (deleteCodeSent ? t('Xác nhận xóa toàn bộ', 'Confirm full deletion') : t('Gửi mã qua Telegram', 'Send code via Telegram')) : t('Tôi hiểu, xóa toàn bộ', 'I understand, delete everything')}</button>
              {session.owner.telegram && deleteCodeSent && <button className="button secondary-action" type="button" onClick={() => void requestDeleteVerificationCode()} disabled={state !== 'idle'}>{t('Gửi lại mã', 'Send code again')}</button>}
              <button type="button" className="button cancel" onClick={() => { setDeletePanelOpen(false); setDeleteConfirmation(''); resetDeleteVerification(); }} disabled={state === 'saving'}>{t('Hủy', 'Cancel')}</button>
            </div>
          </form>
        </section>}
        <div className="manage-grid">
          <section className="panel record-editor"><div className="panel-heading"><span className="block-mark" /><div><p>{editingId ? (editingId === primaryRecord?.id ? 'EDIT PRIMARY RECORD' : 'EDIT RECORD') : 'NEW CHILD RECORD'}</p><h2>{editingId ? (editingId === primaryRecord?.id ? t('Sửa record chính', 'Edit primary record') : t('Sửa DNS record', 'Edit DNS record')) : t('Thêm record con', 'Add child record')}</h2></div></div><form onSubmit={saveRecord}><div className="form-pair"><label>{t('Loại', 'Type')}<select className="field" value={record.recordType} onChange={(event) => { const recordType = event.target.value as RecordType; setRecord((value) => ({ ...value, recordType, proxied: proxyable.has(recordType) ? value.proxied : false, priority: recordType === 'MX' ? value.priority : '' })); }}>{(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as RecordType[]).map((type) => <option value={type} key={type}>{type}</option>)}</select></label><label>{t('Tên', 'Name')}<input className="field" value={record.recordName} onChange={(event) => setRecord((value) => ({ ...value, recordName: event.target.value }))} placeholder={t('@ hoặc web', '@ or web')} required /></label></div><label>{t('Nội dung', 'Content')}<input className="field" value={record.content} onChange={(event) => setRecord((value) => ({ ...value, content: event.target.value }))} placeholder={record.recordType === 'A' ? '203.0.113.10' : record.recordType === 'TXT' ? 'verification=value' : record.recordType === 'CAA' ? '0 issue letsencrypt.org' : 'target.example.com'} required /><small>{record.recordType === 'CAA' ? t('Ví dụ: 0 issue letsencrypt.org', 'Example: 0 issue letsencrypt.org') : t(`Sẽ tạo tại ${recordHost(selected.label, selected.parentDomain, record.recordName || '@')}`, `Will be created at ${recordHost(selected.label, selected.parentDomain, record.recordName || '@')}`)}</small></label><div className="form-pair"><label>TTL<select className="field" value={record.ttl} onChange={(event) => setRecord((value) => ({ ...value, ttl: Number(event.target.value) }))}><option value={1}>Auto</option><option value={60}>{t('60 giây', '60 seconds')}</option><option value={300}>{t('5 phút', '5 minutes')}</option><option value={3600}>{t('1 giờ', '1 hour')}</option></select></label>{record.recordType === 'MX' && <label>{t('Ưu tiên', 'Priority')}<input className="field" type="number" min="0" max="65535" value={record.priority} onChange={(event) => setRecord((value) => ({ ...value, priority: event.target.value }))} required /></label>}</div>{proxyable.has(record.recordType) && <label className="check-row proxy-row"><input type="checkbox" checked={record.proxied} onChange={(event) => setRecord((value) => ({ ...value, proxied: event.target.checked }))} /><span>{t('Proxy qua Cloudflare', 'Proxy through Cloudflare')} <small>{t('Chỉ bật cho web traffic HTTP/HTTPS.', 'Enable only for HTTP/HTTPS web traffic.')}</small></span></label>}<div className="editor-actions"><button className="button" type="submit" disabled={state !== 'idle'}>{state === 'saving' ? t('Đang lưu...', 'Saving...') : editingId ? t('Lưu thay đổi', 'Save changes') : t('Tạo record', 'Create record')}</button>{editingId && <button type="button" className="button cancel" onClick={resetForm}>{t('Hủy', 'Cancel')}</button>}</div></form></section>
          <section className="panel records-panel"><div className="records-heading"><p className="eyebrow"><span className="pixel-dot" /> CHILD RECORDS</p><span className="status">{secondaryRecords.length} {t('records', 'records')}</span></div><div className="record-list">{secondaryRecords.length === 0 ? <p className="empty-copy">{t('Chưa có record con nào.', 'There are no child records yet.')}</p> : secondaryRecords.map((item) => <article className="record-row" key={item.id}><div className="record-main"><span className="record-type">{item.recordType}</span><div><strong>{recordHost(selected.label, selected.parentDomain, item.recordName)}</strong><code>{item.content}{item.priority !== null ? ` · priority ${item.priority}` : ''}</code><small>{ttlLabel(item.ttl)}{item.proxied ? ' · proxied' : ' · DNS only'}</small></div></div><div className="record-actions"><button type="button" className="record-action" onClick={() => editRecord(item)}>{t('Sửa', 'Edit')}</button><button type="button" className="record-action danger-action" onClick={() => void deleteRecord(item)} disabled={state !== 'idle'}>{t('Xóa', 'Delete')}</button></div></article>)}</div></section>
        </div>
      </>}
    </>}
  </div></main>;
}
