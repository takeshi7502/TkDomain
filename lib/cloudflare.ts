import type { ValidatedDnsRecord } from './dns';

type CloudflareResult = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: { id?: string; comment?: string; content?: string } | Array<{ id?: string; comment?: string; content?: string }>;
};

function getCloudflareConfig() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) throw new Error('DNS provisioning is not configured yet.');
  return { token, zoneId };
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

async function callCloudflare(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: object) {
  const { token, zoneId } = getCloudflareConfig();
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as CloudflareResult;
  const recordResult = Array.isArray(payload.result) ? undefined : payload.result;
  if (method === 'DELETE' && response.status === 404) return payload;
  if (!response.ok || !payload.success || (method !== 'DELETE' && !recordResult?.id)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare DNS rejected this record.');
  }
  return payload;
}

export async function createCloudflareRecord(name: string, record: ValidatedDnsRecord, comment: string) {
  const payload = await callCloudflare('/dns_records', 'POST', recordPayload(name, record, comment));
  return (payload.result as { id: string }).id;
}

export async function findCloudflareRecordByComment(name: string, record: ValidatedDnsRecord, comment: string) {
  const { token, zoneId } = getCloudflareConfig();
  const query = new URLSearchParams({ name, type: record.recordType });
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({})) as CloudflareResult;
  if (!response.ok || !payload.success || !Array.isArray(payload.result)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare DNS lookup failed.');
  }
  return payload.result.find((item) => item.comment === comment && item.content === record.content)?.id ?? null;
}

export async function updateCloudflareRecord(recordId: string, name: string, record: ValidatedDnsRecord, comment: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'PUT', recordPayload(name, record, comment));
}

export async function deleteCloudflareRecord(recordId: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'DELETE');
}
