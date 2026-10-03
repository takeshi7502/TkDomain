import { and, asc, eq } from 'drizzle-orm';
import { after, NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { dnsOperations, dnsRecords, managedDomains, subdomains } from '@/db/schema';
import { validateDnsRecord } from '@/lib/dns';
import { beginDnsOperation, resumeDnsOperations, runDnsOperation } from '@/lib/dns-operations';
import { errorResponse, HttpError, readJson, trustedMutation, validId } from '@/lib/http';
import { getOwnerSession } from '@/lib/owner-auth';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const limit = await enforceRegistryScopedRateLimit('dns-read-owner', session.owner.id, 30, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Tải panel quá nhanh. Hãy chờ một phút.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  const db = getDb(), ownerId = session.owner.id;
  const domains = await db.select({ id: subdomains.id, label: subdomains.label, parentDomain: managedDomains.hostname, status: subdomains.status })
    .from(subdomains).innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id))
    .where(eq(subdomains.ownerId, ownerId)).orderBy(asc(managedDomains.hostname), asc(subdomains.label));
  const records = await db.select({ record: dnsRecords }).from(dnsRecords).innerJoin(subdomains, eq(dnsRecords.subdomainId, subdomains.id))
    .where(eq(subdomains.ownerId, ownerId)).orderBy(asc(dnsRecords.recordName), asc(dnsRecords.recordType));
  const pending = await db.select({ subdomainId: dnsOperations.subdomainId, id: dnsOperations.id }).from(dnsOperations)
    .where(and(eq(dnsOperations.ownerId, ownerId), eq(dnsOperations.status, 'pending')));
  const byDomain = new Map<string, typeof dnsRecords.$inferSelect[]>();
  for (const { record } of records) {
    const list = byDomain.get(record.subdomainId) ?? [];
    list.push(record); byDomain.set(record.subdomainId, list);
  }
  if (pending.length) after(async () => { try { await resumeDnsOperations(ownerId, 1); } catch { console.warn('DNS reconciliation deferred.'); } });
  return NextResponse.json({ subdomains: domains.map((d) => ({ ...d, records: byDomain.get(d.id) ?? [], operationPending: pending.some((op) => op.subdomainId === d.id) })) });
}

async function mutate(request: NextRequest, kind: 'create' | 'update' | 'delete') {
  if (!trustedMutation(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const limits = await Promise.all([
    enforceRegistryRateLimit(request, 'dns-write-ip', 30, 60_000),
    enforceRegistryScopedRateLimit('dns-write-owner', session.owner.id, 10, 60_000),
    enforceRegistryScopedRateLimit('dns-write-global', 'registry', 60, 60_000),
    enforceRegistryScopedRateLimit('dns-write-owner-daily', session.owner.id, 200, 86400_000),
    enforceRegistryScopedRateLimit('dns-write-global-daily', 'registry', 1000, 86400_000),
  ]);
  if (limits.some((l) => !l.allowed)) return NextResponse.json({ error: 'Đã đạt giới hạn thao tác DNS. Hãy thử lại sau.' }, { status: 429, headers: { 'Retry-After': String(Math.max(...limits.filter((l) => !l.allowed).map((l) => l.retryAfterSeconds))) } });
  try {
    const body = kind === 'delete' ? {} : await readJson(request);
    const recordId = kind === 'delete' ? request.nextUrl.searchParams.get('id') : body.id;
    const suppliedId = request.headers.get('idempotency-key');
    if (suppliedId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(suppliedId)) throw new HttpError('Invalid operation ID.');
    let subdomainId = body.subdomainId;
    if (kind !== 'create') {
      if (!validId(recordId)) throw new HttpError('Missing DNS record.');
      const [row] = await getDb().select({ subdomainId: subdomains.id }).from(dnsRecords).innerJoin(subdomains, eq(dnsRecords.subdomainId, subdomains.id))
        .where(and(eq(dnsRecords.id, recordId), eq(subdomains.ownerId, session.owner.id))).limit(1);
      if (!row) {
        // A DELETE retry may arrive after the original response was lost.
        if (kind === 'delete' && suppliedId) {
          const [old] = await getDb().select().from(dnsOperations).where(and(eq(dnsOperations.id, suppliedId), eq(dnsOperations.ownerId, session.owner.id), eq(dnsOperations.kind, 'delete')));
          const p = old?.payload as { recordId?: string } | undefined;
          if (old?.status === 'done' && p?.recordId === recordId) return NextResponse.json(old.result);
        }
        throw new HttpError('Record không tồn tại.', 404);
      }
      subdomainId = row.subdomainId;
    }
    if (!validId(subdomainId)) throw new HttpError('Missing subdomain.');
    const validated = kind === 'delete' ? null : validateDnsRecord(body);
    if (validated && 'error' in validated) throw new HttpError(validated.error);
    const op = await beginDnsOperation({
      id: suppliedId ?? crypto.randomUUID(), kind, ownerId: session.owner.id, subdomainId,
      ...(typeof recordId === 'string' ? { recordId } : {}),
      ...(validated && 'value' in validated ? { after: validated.value } : {}),
    });
    const result = op.unchanged ? { ok: true } : await runDnsOperation(op.id);
    if ('pending' in result && result.pending) after(async () => { try { await resumeDnsOperations(session.owner.id, 1); } catch { console.warn('DNS reconciliation deferred.'); } });
    return NextResponse.json(result, { status: 'pending' in result && result.pending ? 202 : 200 });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    console.error('DNS operation could not be accepted.');
    return NextResponse.json({ error: 'Không thể xử lý DNS lúc này. Hãy tải lại panel trước khi thử lại.' }, { status: 503 });
  }
}
export async function POST(request: NextRequest) { return mutate(request, 'create'); }
export async function PATCH(request: NextRequest) { return mutate(request, 'update'); }
export async function DELETE(request: NextRequest) { return mutate(request, 'delete'); }
