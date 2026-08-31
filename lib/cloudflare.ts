import type { ValidatedDnsRecord } from './dns';

type CloudflareResult = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: CloudflareRecord | CloudflareZone | Array<CloudflareRecord | CloudflareZone>;
};

type CloudflareRecord = {
  id?: string;
  comment?: string;
  content?: string;
};

export type CloudflareZone = {
  id: string;
  name: string;
  status?: string;
};

function getCloudflareToken() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('DNS provisioning is not configured yet.');
  return token;
}

/**
 * Existing production deployments still obtain their zone from the environment.
 * New multi-domain callers must pass the zone ID saved for the selected parent
 * domain. Keeping the optional fallback prevents a migration from accidentally
 * breaking records which predate the registry_domains table.
 */
function getCloudflareZoneId(explicitZoneId?: string) {
  const zoneId = explicitZoneId ?? process.env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) throw new Error('DNS provisioning is not configured yet.');
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('The configured Cloudflare zone ID is invalid.');
  return zoneId;
}

function getCloudflareConfig(explicitZoneId?: string) {
  return { token: getCloudflareToken(), zoneId: getCloudflareZoneId(explicitZoneId) };
}

function recordPayload(name: string, record: ValidatedDnsRecord, comment: string) {
  return {
    type: record.recordType,
    name,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
    ...(record.priority === null ? {} : { priority: record.priority }),
    comment,
  };
}

async function callCloudflare(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: object, explicitZoneId?: string) {
  const { token, zoneId } = getCloudflareConfig(explicitZoneId);
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as CloudflareResult;
  const recordResult = Array.isArray(payload.result) ? undefined : payload.result as CloudflareRecord | undefined;
  if (method === 'DELETE' && response.status === 404) return payload;
  if (!response.ok || !payload.success || (method !== 'DELETE' && !recordResult?.id)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare DNS rejected this record.');
  }
  return payload;
}

/**
 * `zoneId` is optional only for backwards compatibility with takeshi.dev.
 * All new registry-domain code should pass the zone ID persisted for the
 * selected parent domain.
 */
export async function createCloudflareRecord(name: string, record: ValidatedDnsRecord, comment: string, zoneId?: string) {
  const payload = await callCloudflare('/dns_records', 'POST', recordPayload(name, record, comment), zoneId);
  return (payload.result as { id: string }).id;
}

export async function findCloudflareRecordByComment(name: string, record: ValidatedDnsRecord, comment: string, explicitZoneId?: string) {
  const { token, zoneId } = getCloudflareConfig(explicitZoneId);
  const query = new URLSearchParams({ name, type: record.recordType });
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({})) as CloudflareResult;
  if (!response.ok || !payload.success || !Array.isArray(payload.result)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare DNS lookup failed.');
  }
  return (payload.result as CloudflareRecord[]).find((item) => item.comment === comment && item.content === record.content)?.id ?? null;
}

export async function updateCloudflareRecord(recordId: string, name: string, record: ValidatedDnsRecord, comment: string, zoneId?: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'PUT', recordPayload(name, record, comment), zoneId);
}

export async function deleteCloudflareRecord(recordId: string, zoneId?: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'DELETE', undefined, zoneId);
}

function normalizeZoneName(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function isValidZoneName(value: string) {
  if (value.length > 253 || value.includes('..')) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/**
 * Resolves a zone by its exact apex name while an admin adds a parent domain.
 * This needs a token with Zone > Zone > Read on the chosen zone(s), in addition
 * to Zone > DNS > Edit for normal record provisioning. It intentionally returns
 * no token or account information to its caller.
 */
export async function findCloudflareZoneByName(domain: string): Promise<CloudflareZone | null> {
  const name = normalizeZoneName(domain);
  if (!isValidZoneName(name)) throw new Error('The parent domain is invalid.');

  const token = getCloudflareToken();
  const query = new URLSearchParams({ name, status: 'active', per_page: '50' });
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({})) as CloudflareResult;
  if (!response.ok || !payload.success || !Array.isArray(payload.result)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare zone lookup failed.');
  }

  const zone = (payload.result as CloudflareZone[]).find((candidate) => candidate.name?.toLowerCase() === name);
  if (!zone?.id || !/^[a-f0-9]{32}$/i.test(zone.id)) return null;
  return { id: zone.id, name: name, status: zone.status };
}
