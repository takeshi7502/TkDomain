export const BASE_DOMAIN = 'takeshi.dev';
export const OWNER_ACCESS_KEY_PREFIX = 'tk-';

export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'app', 'domain', 'domains', 'mail', 'smtp', 'imap',
  'pop', 'ftp', 'cdn', 'static', 'status', 'support', 'help', 'docs', 'blog',
  'dashboard', 'auth', 'login', 'register', 'billing', 'ns1', 'ns2', 'root',
]);

export type ClaimInput = {
  subdomain: string;
  parentDomainId: string;
  cnameTarget: string;
  telegramUsername: string;
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

export function normalizeTelegramUsername(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function isValidTelegramUsername(value: string) {
  return /^[a-z][a-z0-9_]{4,31}$/i.test(value);
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
  const cnameTarget = normalizeCname(typeof input.cnameTarget === 'string' ? input.cnameTarget : '');
  const telegramUsername = normalizeTelegramUsername(typeof input.telegramUsername === 'string' ? input.telegramUsername : '');
  const accessKey = typeof input.accessKey === 'string' ? input.accessKey.trim() : '';

  if (typeof input.website === 'string' && input.website.trim()) return { error: 'Request could not be verified.' as const };
  if (!isValidSubdomain(subdomain)) return { error: 'Tên subdomain không hợp lệ hoặc đang được reserved.' as const };
  if (!parentDomainId || parentDomainId.length > 120) return { error: 'Tên miền đăng ký không hợp lệ.' as const };
  if (!isValidCnameTarget(cnameTarget, registryDomains)) return { error: 'CNAME destination không hợp lệ.' as const };
  if (!isValidTelegramUsername(telegramUsername)) return { error: 'Telegram username không hợp lệ.' as const };
  if (!isValidOwnerAccessKey(accessKey)) return { error: 'Access key phải bắt đầu bằng tk-, có phần tự đặt dài 11–29 ký tự, gồm cả chữ và số; chỉ dùng . _ - khi cần.' as const };
  if (input.acceptedRules !== true) return { error: 'Bạn cần đồng ý với registry rules.' as const };

  return { value: { subdomain, parentDomainId, cnameTarget, telegramUsername, accessKey } };
}
