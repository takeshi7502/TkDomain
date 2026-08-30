import type { ValidatedDnsRecord } from './dns';

type CloudflareResult = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: { id?: string };
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
  if (!response.ok || !payload.success || (method !== 'DELETE' && !payload.result?.id)) {
    throw new Error(payload.errors?.[0]?.message ?? 'Cloudflare DNS rejected this record.');
  }
  return payload;
}

export async function createCloudflareRecord(name: string, record: ValidatedDnsRecord, comment: string) {
  const payload = await callCloudflare('/dns_records', 'POST', recordPayload(name, record, comment));
  return payload.result!.id!;
}

export async function updateCloudflareRecord(recordId: string, name: string, record: ValidatedDnsRecord, comment: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'PUT', recordPayload(name, record, comment));
}

export async function deleteCloudflareRecord(recordId: string) {
  await callCloudflare(`/dns_records/${recordId}`, 'DELETE');
}
