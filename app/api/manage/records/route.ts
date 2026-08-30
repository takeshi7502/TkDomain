import { and, asc, eq } from 'drizzle-orm';
import { after, NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { dnsEvents, dnsRecords, subdomains } from '@/db/schema';
import { createCloudflareRecord, deleteCloudflareRecord, updateCloudflareRecord } from '@/lib/cloudflare';
import { fullRecordName, type DnsRecordInput, validateDnsRecord } from '@/lib/dns';
import { getOwnerSession } from '@/lib/owner-auth';
import { sendTelegramMessageToOwner } from '@/lib/telegram';

async function currentOwner(request: NextRequest) {
  const session = await getOwnerSession(request);
  if (!session) return null;
  return session.owner;
}

async function ownedSubdomain(ownerId: string, subdomainId: string) {
  return getDb().query.subdomains.findFirst({ where: and(eq(subdomains.id, subdomainId), eq(subdomains.ownerId, ownerId), eq(subdomains.status, 'active')) });
}

function auditRecordSummary(record: { recordType: string; recordName: string; ttl: number; proxied: boolean; priority: number | null }) {
  return {
    type: record.recordType,
    name: record.recordName,
    ttl: record.ttl,
    proxied: record.proxied,
    priority: record.priority,
  };
}

function recordActionLabel(action: 'created' | 'updated' | 'deleted') {
  return action === 'created' ? 'đã tạo' : action === 'updated' ? 'đã cập nhật' : 'đã xóa';
}

/**
 * Telegram is an optional convenience channel. Run it after the response so a
 * transient Bot API/database failure can never make a successful Cloudflare
 * change look failed to the DNS-panel owner.
 */
function notifyOwnerAboutDnsChange(args: {
  ownerId: string;
  action: 'created' | 'updated' | 'deleted';
  domainLabel: string;
  recordType: string;
  recordName: string;
}) {
  const hostname = args.recordName === '@'
    ? `${args.domainLabel}.takeshi.dev`
    : `${args.recordName}.${args.domainLabel}.takeshi.dev`;
  after(async () => {
    try {
      await sendTelegramMessageToOwner(args.ownerId, [
        'TAKESHI DOMAINS',
        '',
        `DNS record ${recordActionLabel(args.action)}.`,
        `${args.recordType} · ${hostname}`,
        '',
        'Mở DNS Panel để xem chi tiết.',
      ].join('\n'));
    } catch {
      // Delivery is deliberately best-effort; do not log record contents,
      // chat IDs, or an owner identifier here.
      console.warn('Optional Telegram DNS notification could not be sent.');
    }
  });
}

export async function GET(request: NextRequest) {
  const owner = await currentOwner(request);
  if (!owner) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const domains = await getDb().select({ id: subdomains.id, label: subdomains.label, status: subdomains.status }).from(subdomains).where(eq(subdomains.ownerId, owner.id)).orderBy(asc(subdomains.label));
  const records = domains.length === 0
    ? []
    : await getDb().select().from(dnsRecords).innerJoin(subdomains, eq(dnsRecords.subdomainId, subdomains.id)).where(eq(subdomains.ownerId, owner.id)).orderBy(asc(dnsRecords.recordName), asc(dnsRecords.recordType));

  return NextResponse.json({
    subdomains: domains.map((domain) => ({
      ...domain,
      records: records.filter((row) => row.dns_records.subdomainId === domain.id).map((row) => row.dns_records),
    })),
  });
}

export async function POST(request: NextRequest) {
  const owner = await currentOwner(request);
  if (!owner) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  let body: DnsRecordInput & { subdomainId?: string };
  try { body = await request.json() as DnsRecordInput & { subdomainId?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (!body.subdomainId) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });
  const domain = await ownedSubdomain(owner.id, body.subdomainId);
  if (!domain) return NextResponse.json({ error: 'Subdomain không tồn tại hoặc không thuộc quyền quản lý của bạn.' }, { status: 404 });
  const validated = validateDnsRecord(body);
  if ('error' in validated) return NextResponse.json(validated, { status: 400 });

  let cloudflareRecordId: string;
  try {
    cloudflareRecordId = await createCloudflareRecord(fullRecordName(domain.label, validated.value.recordName), validated.value, `Takeshi Domains owner ${owner.id}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare DNS rejected this record.' }, { status: 502 });
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await getDb().insert(dnsRecords).values({ id, subdomainId: domain.id, ...validated.value, isPrimary: false, cloudflareRecordId, createdAt: now, updatedAt: now });
  await getDb().insert(dnsEvents).values({
    id: crypto.randomUUID(),
    subdomainId: domain.id,
    domainLabel: domain.label,
    recordId: id,
    actorType: 'owner',
    action: 'child_record_created',
    details: { ...auditRecordSummary(validated.value), isPrimary: false },
    createdAt: now,
  });
  notifyOwnerAboutDnsChange({
    ownerId: owner.id,
    action: 'created',
    domainLabel: domain.label,
    recordType: validated.value.recordType,
    recordName: validated.value.recordName,
  });
  return NextResponse.json({ ok: true, record: { id, cloudflareRecordId, ...validated.value, createdAt: now, updatedAt: now } }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const owner = await currentOwner(request);
  if (!owner) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  let body: DnsRecordInput & { id?: string };
  try { body = await request.json() as DnsRecordInput & { id?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: 'Missing DNS record.' }, { status: 400 });
  const rows = await getDb().select({ record: dnsRecords, domain: subdomains }).from(dnsRecords).innerJoin(subdomains, eq(dnsRecords.subdomainId, subdomains.id)).where(and(eq(dnsRecords.id, body.id), eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active'))).limit(1);
  const current = rows[0];
  if (!current) return NextResponse.json({ error: 'DNS record không tồn tại hoặc không thuộc quyền quản lý của bạn.' }, { status: 404 });
  const validated = validateDnsRecord(body);
  if ('error' in validated) return NextResponse.json(validated, { status: 400 });

  try {
    await updateCloudflareRecord(current.record.cloudflareRecordId, fullRecordName(current.domain.label, validated.value.recordName), validated.value, `Takeshi Domains owner ${owner.id}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare DNS rejected this record.' }, { status: 502 });
  }
  const now = Date.now();
  await getDb().update(dnsRecords).set({ ...validated.value, updatedAt: now }).where(eq(dnsRecords.id, current.record.id));
  await getDb().insert(dnsEvents).values({
    id: crypto.randomUUID(),
    subdomainId: current.domain.id,
    domainLabel: current.domain.label,
    recordId: current.record.id,
    actorType: 'owner',
    action: current.record.isPrimary ? 'primary_record_updated' : 'child_record_updated',
    details: {
      before: {
        ...auditRecordSummary(current.record),
      },
      after: {
        ...auditRecordSummary(validated.value),
      },
      contentChanged: current.record.content !== validated.value.content,
      isPrimary: current.record.isPrimary,
    },
    createdAt: now,
  });
  notifyOwnerAboutDnsChange({
    ownerId: owner.id,
    action: 'updated',
    domainLabel: current.domain.label,
    recordType: validated.value.recordType,
    recordName: validated.value.recordName,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const owner = await currentOwner(request);
  if (!owner) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing DNS record.' }, { status: 400 });
  const rows = await getDb().select({ record: dnsRecords, domain: subdomains }).from(dnsRecords).innerJoin(subdomains, eq(dnsRecords.subdomainId, subdomains.id)).where(and(eq(dnsRecords.id, id), eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active'))).limit(1);
  const current = rows[0];
  if (!current) return NextResponse.json({ error: 'DNS record không tồn tại hoặc không thuộc quyền quản lý của bạn.' }, { status: 404 });
  if (current.record.isPrimary) return NextResponse.json({ error: 'Primary record cannot be deleted here. Use the remove-subdomain action instead.' }, { status: 409 });
  try {
    await deleteCloudflareRecord(current.record.cloudflareRecordId);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare DNS rejected this record.' }, { status: 502 });
  }
  const now = Date.now();
  await getDb().delete(dnsRecords).where(eq(dnsRecords.id, current.record.id));
  await getDb().insert(dnsEvents).values({
    id: crypto.randomUUID(),
    subdomainId: current.domain.id,
    domainLabel: current.domain.label,
    recordId: current.record.id,
    actorType: 'owner',
    action: 'child_record_deleted',
    details: { ...auditRecordSummary(current.record), isPrimary: false },
    createdAt: now,
  });
  notifyOwnerAboutDnsChange({
    ownerId: owner.id,
    action: 'deleted',
    domainLabel: current.domain.label,
    recordType: current.record.recordType,
    recordName: current.record.recordName,
  });
  return NextResponse.json({ ok: true });
}
