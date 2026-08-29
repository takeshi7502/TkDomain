export const BASE_DOMAIN = 'takeshi.dev';

export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'app', 'domain', 'domains', 'mail', 'smtp', 'imap',
  'pop', 'ftp', 'cdn', 'static', 'status', 'support', 'help', 'docs', 'blog',
  'dashboard', 'auth', 'login', 'register', 'billing', 'ns1', 'ns2', 'root',
]);

export type ClaimInput = {
  subdomain: string;
  cnameTarget: string;
  githubHandle: string;
  email: string;
  acceptedRules: boolean;
  website?: string;
};

export function normalizeSubdomain(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeCname(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

export function isValidSubdomain(value: string) {
  return /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !RESERVED_SUBDOMAINS.has(value);
}

export function isValidCnameTarget(value: string) {
  if (value.length > 253 || value.includes('..') || value === BASE_DOMAIN || value.endsWith(`.${BASE_DOMAIN}`)) return false;
  return value.split('.').length >= 2 && value.split('.').every((label) => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function isValidGithubHandle(value: string) {
  return value.length === 0 || /^@?[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);
}

export function isValidEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validateClaim(input: ClaimInput) {
  const subdomain = normalizeSubdomain(input.subdomain);
  const cnameTarget = normalizeCname(input.cnameTarget);
  const githubHandle = input.githubHandle.trim().replace(/^@/, '');
  const email = input.email.trim().toLowerCase();

  if (input.website?.trim()) return { error: 'Request could not be verified.' as const };
  if (!isValidSubdomain(subdomain)) return { error: 'Tên subdomain không hợp lệ hoặc đang được reserved.' as const };
  if (!isValidCnameTarget(cnameTarget)) return { error: 'CNAME destination không hợp lệ.' as const };
  if (!isValidGithubHandle(githubHandle)) return { error: 'GitHub handle không hợp lệ.' as const };
  if (!isValidEmail(email)) return { error: 'Email không hợp lệ.' as const };
  if (!input.acceptedRules) return { error: 'Bạn cần đồng ý với registry rules.' as const };

  return { value: { subdomain, cnameTarget, githubHandle: githubHandle || null, email } };
}
