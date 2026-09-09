export const BASE_DOMAIN = 'takeshi.dev';
export const OWNER_ACCESS_KEY_PREFIX = 'tk-';
export const REGISTRATION_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as const;
export type RegistrationRecordType = (typeof REGISTRATION_RECORD_TYPES)[number];

export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'app', 'domain', 'domains', 'mail', 'smtp', 'imap',
  'pop', 'ftp', 'cdn', 'static', 'status', 'support', 'help', 'docs', 'blog',
  'dashboard', 'auth', 'login', 'register', 'billing', 'ns1', 'ns2', 'root',
]);

export type ClaimInput = {
  subdomain: string;
  parentDomainId: string;
  recordType: RegistrationRecordType;
  recordContent: string;
  recordPriority?: number | null;
  telegramUsername: string;
  notificationEmail: string;
  notificationLanguage?: 'vi' | 'en';
  accessKey: string;
  acceptedRules: boolean;
  website?: string;
};

export function normalizeSubdomain(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeParentDomain(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

export function isValidParentDomain(value: string) {
  if (value.length > 253 || value.includes('..')) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function normalizeCname(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

export function isValidSubdomain(value: string) {
  return /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !RESERVED_SUBDOMAINS.has(value);
}

export function isValidCnameTarget(value: string, registryDomains: readonly string[] = [BASE_DOMAIN]) {
  if (value.length > 253 || value.includes('..')) return false;
  const normalizedDomains = registryDomains.map((domain) => domain.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (normalizedDomains.some((domain) => value === domain || value.endsWith(`.${domain}`))) return false;
  return value.split('.').length >= 2 && value.split('.').every((label) => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function isValidIpv4(value: string) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => (
    /^\d{1,3}$/.test(part)
    && Number(part) <= 255
    && (part === '0' || !part.startsWith('0'))
  ));
}

function isValidIpv6(value: string) {
  let normalized = value.trim().toLowerCase();
  if (!normalized || normalized.includes('%') || !/^[0-9a-f:.]+$/.test(normalized)) return false;
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    if (separator < 0 || !isValidIpv4(normalized.slice(separator + 1))) return false;
    normalized = `${normalized.slice(0, separator)}:0:0`;
  }
  if ((normalized.startsWith(':') && !normalized.startsWith('::')) || (normalized.endsWith(':') && !normalized.endsWith('::'))) return false;
  const halves = normalized.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half ? half.split(':') : []);
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return false;
  return halves.length === 1 ? groups.length === 8 : groups.length < 8;
}

export type PrimaryRecordValidation =
  | { value: { recordType: RegistrationRecordType; recordContent: string; recordPriority: number | null } }
  | { error: string; field: 'recordType' | 'recordContent' | 'recordPriority' };

export function validatePrimaryRecord(
  input: { recordType?: unknown; recordContent?: unknown; recordPriority?: unknown },
  registryDomains: readonly string[] = [BASE_DOMAIN],
): PrimaryRecordValidation {
  if (typeof input.recordType !== 'string' || !REGISTRATION_RECORD_TYPES.includes(input.recordType as RegistrationRecordType)) {
    return { error: 'Loại DNS record không được hỗ trợ.', field: 'recordType' };
  }
  const recordType = input.recordType as RegistrationRecordType;
  const rawContent = typeof input.recordContent === 'string' ? input.recordContent.trim() : '';
  const recordContent = recordType === 'CNAME' || recordType === 'MX' ? normalizeCname(rawContent) : rawContent;
  if (!recordContent || recordContent.length > 2_048) {
    return { error: 'Nội dung record phải dài từ 1 đến 2048 ký tự.', field: 'recordContent' };
  }
  if (recordType === 'A' && !isValidIpv4(recordContent)) {
    return { error: 'A record cần một địa chỉ IPv4 hợp lệ.', field: 'recordContent' };
  }
  if (recordType === 'AAAA' && !isValidIpv6(recordContent)) {
    return { error: 'AAAA record cần một địa chỉ IPv6 hợp lệ.', field: 'recordContent' };
  }
  if (recordType === 'CNAME' && !isValidCnameTarget(recordContent, registryDomains)) {
    return { error: 'CNAME cần hostname hợp lệ và không được trỏ vào domain của registry.', field: 'recordContent' };
  }
  if (recordType === 'MX' && !isValidParentDomain(recordContent)) {
    return { error: 'MX record cần một hostname hợp lệ.', field: 'recordContent' };
  }
  if (recordType === 'TXT' && /[\r\n]/.test(recordContent)) {
    return { error: 'TXT record chỉ được nhập trên một dòng.', field: 'recordContent' };
  }
  if (recordType === 'CAA' && !/^\d{1,3}\s+(issue|issuewild|iodef)\s+.+$/i.test(recordContent)) {
    return { error: 'CAA dùng dạng: 0 issue letsencrypt.org', field: 'recordContent' };
  }

  const recordPriority = input.recordPriority === '' || input.recordPriority === undefined || input.recordPriority === null
    ? null
    : Number(input.recordPriority);
  if (recordType === 'MX' && (recordPriority === null || !Number.isInteger(recordPriority) || recordPriority < 0 || recordPriority > 65_535)) {
    return { error: 'MX priority phải là số nguyên từ 0 đến 65535.', field: 'recordPriority' };
  }
  if (recordType !== 'MX' && recordPriority !== null) {
    return { error: 'Chỉ MX record dùng priority.', field: 'recordPriority' };
  }
  return { value: { recordType, recordContent, recordPriority: recordType === 'MX' ? recordPriority : null } };
}

export function normalizeTelegramUsername(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function isValidTelegramUsername(value: string) {
  return /^[a-z][a-z0-9_]{4,31}$/i.test(value);
}

/** One ordinary mailbox only; reject headers, recipient lists and display names. */
export function isValidNotificationEmail(value: string) {
  if (value.length > 254 || /[\s\r\n]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && local.length <= 64
    && /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/i.test(local)
    && isValidParentDomain(domain.toLowerCase());
}

export function isValidOwnerAccessKey(value: string) {
  if (!value.startsWith(OWNER_ACCESS_KEY_PREFIX)) return false;
  const suffix = value.slice(OWNER_ACCESS_KEY_PREFIX.length);
  return suffix.length > 10
    && suffix.length < 30
    && /^[a-z0-9._-]+$/i.test(suffix)
    && /[a-z]/i.test(suffix)
    && /\d/.test(suffix);
}

export function validateClaim(input: Partial<ClaimInput>, registryDomains: readonly string[] = [BASE_DOMAIN]) {
  const subdomain = normalizeSubdomain(typeof input.subdomain === 'string' ? input.subdomain : '');
  const parentDomainId = typeof input.parentDomainId === 'string' ? input.parentDomainId.trim() : '';
  const telegramUsername = normalizeTelegramUsername(typeof input.telegramUsername === 'string' ? input.telegramUsername : '');
  const accessKey = typeof input.accessKey === 'string' ? input.accessKey.trim() : '';
  const notificationEmail = typeof input.notificationEmail === 'string' ? input.notificationEmail.trim().toLowerCase() : '';
  const notificationLanguage = input.notificationLanguage === 'en' ? 'en' as const : 'vi' as const;

  if (typeof input.website === 'string' && input.website.trim()) return { error: 'Request could not be verified.' as const };
  if (!isValidSubdomain(subdomain)) return { error: 'Tên subdomain không hợp lệ hoặc đang được reserved.' as const };
  if (!parentDomainId || parentDomainId.length > 120) return { error: 'Tên miền đăng ký không hợp lệ.' as const };
  const primaryRecord = validatePrimaryRecord(input, registryDomains);
  if ('error' in primaryRecord) return primaryRecord;
  if (!isValidTelegramUsername(telegramUsername)) return { error: 'Telegram username không hợp lệ.' as const };
  if (typeof input.notificationEmail !== 'string' || !isValidNotificationEmail(notificationEmail)) {
    return { error: 'Bạn cần nhập email nhận thông báo hợp lệ. Ví dụ: you@example.com.' as const, field: 'notificationEmail' as const };
  }
  if (!isValidOwnerAccessKey(accessKey)) return { error: 'Access key phải bắt đầu bằng tk-, có phần tự đặt dài 11–29 ký tự, gồm cả chữ và số; chỉ dùng . _ - khi cần.' as const };
  if (input.acceptedRules !== true) return { error: 'Bạn cần đồng ý với registry rules.' as const };

  return { value: { subdomain, parentDomainId, ...primaryRecord.value, telegramUsername, accessKey, notificationEmail, notificationLanguage } };
}
