import { isIP } from 'node:net';

import { BASE_DOMAIN } from './registry';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export type DnsRecordInput = {
  recordType: DnsRecordType;
  recordName: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number | null;
};

export type ValidatedDnsRecord = {
  recordType: DnsRecordType;
  recordName: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
};

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function isValidHostname(value: string) {
  if (value.length > 253 || value.includes('..')) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function fullRecordName(label: string, recordName: string) {
  const host = `${label}.${BASE_DOMAIN}`;
  return recordName === '@' ? host : `${recordName}.${host}`;
}

function normalizeRecordName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  return normalized || '@';
}

function isValidRecordName(value: string) {
  if (value === '@') return true;
  if (value.length > 120 || value.includes('..')) return false;
  return value.split('.').every((label) => /^(?=.{1,63}$)[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label));
}

function validTtl(value: number) {
  return value === 1 || (Number.isInteger(value) && value >= 60 && value <= 86_400);
}

export function validateDnsRecord(input: DnsRecordInput): { value: ValidatedDnsRecord } | { error: string } {
  const recordType = input.recordType;
  const recordName = normalizeRecordName(input.recordName);
  const content = input.content.trim();
  const ttl = Number(input.ttl ?? 1);
  const priority = input.priority === undefined || input.priority === null
    ? null
    : Number(input.priority);
  const canProxy = recordType === 'A' || recordType === 'AAAA' || recordType === 'CNAME';
  const proxied = canProxy && Boolean(input.proxied);

  if (!DNS_RECORD_TYPES.includes(recordType)) return { error: 'Record type không được hỗ trợ.' };
  if (!isValidRecordName(recordName)) return { error: 'Tên record không hợp lệ.' };
  if (!validTtl(ttl)) return { error: 'TTL phải là Auto hoặc từ 60 đến 86400 giây.' };
  if (content.length === 0 || content.length > 2_048) return { error: 'Giá trị record không hợp lệ.' };

  if (recordType === 'A' && isIP(content) !== 4) return { error: 'A record cần địa chỉ IPv4 hợp lệ.' };
  if (recordType === 'AAAA' && isIP(content) !== 6) return { error: 'AAAA record cần địa chỉ IPv6 hợp lệ.' };
  if ((recordType === 'CNAME' || recordType === 'MX') && !isValidHostname(normalizeHostname(content))) {
    return { error: `${recordType} record cần hostname hợp lệ.` };
  }
  if (recordType === 'MX' && (priority === null || !Number.isInteger(priority) || priority < 0 || priority > 65_535)) {
    return { error: 'MX record cần priority từ 0 đến 65535.' };
  }
  if (recordType !== 'MX' && priority !== null) return { error: 'Chỉ MX record dùng priority.' };
  if (recordType === 'CAA' && !/^\d{1,3}\s+(issue|issuewild|iodef)\s+.+$/i.test(content)) {
    return { error: 'CAA dùng dạng: 0 issue letsencrypt.org' };
  }

  return {
    value: {
      recordType,
      recordName,
      content: recordType === 'CNAME' || recordType === 'MX' ? normalizeHostname(content) : content,
      ttl,
      proxied,
      priority: recordType === 'MX' ? priority : null,
    },
  };
}
