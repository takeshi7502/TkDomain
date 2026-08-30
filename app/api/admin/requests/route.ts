import { desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { dnsEvents, dnsRecords, owners, ownerSessions, subdomains, subdomainRequests } from '@/db/schema';
import { createCloudflareRecord } from '@/lib/cloudflare';
import { fullRecordName, type ValidatedDnsRecord } from '@/lib/dns';
import { createOwnerAccessKey, hashOwnerAccessKey } from '@/lib/owner-auth';
import { BASE_DOMAIN } from '@/lib/registry';

function authorized(request: NextRequest) {
  const key = request.headers.get('x-registry-admin-key');
  return Boolean(process.env.REGISTRY_ADMIN_KEY && key && key === process.env.REGISTRY_ADMIN_KEY);
}

async function findOrCreateOwner(email: string, githubHandle: string | null) {
  const db = getDb();
  let owner = await db.query.owners.findFirst({ where: eq(owners.email, email) });
  let accessKey: string | null = null;
  const now = Date.now();

  if (!owner) {
    accessKey = createOwnerAccessKey();
    const id = crypto.randomUUID();
    const accessKeyHash = hashOwnerAccessKey(accessKey);
    await db.insert(owners).values({ id, email, githubHandle, accessKeyHash, status: 'active', createdAt: now, updatedAt: now });
    owner = { id, email, githubHandle, accessKeyHash, status: 'active' as const, createdAt: now, updatedAt: now };
  } else if (!owner.accessKeyHash) {
    accessKey = createOwnerAccessKey();
    await db.update(owners).set({ accessKeyHash: hashOwnerAccessKey(accessKey), updatedAt: now }).where(eq(owners.id, owner.id));
  }

  return { owner, accessKey };
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  await ensureRegistrySchema();
  const requests = await getDb().select().from(subdomainRequests).orderBy(desc(subdomainRequests.createdAt)).limit(100);
  return NextResponse.json({ requests });
}

export async function PATCH(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await request.json() as { id?: string; action?: 'provision' | 'reject' | 'reset_access'; note?: string };
  if (!body.id || !body.action) return NextResponse.json({ error: 'Missing request action.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const requestRecord = await db.query.subdomainRequests.findFirst({ where: eq(subdomainRequests.id, body.id) });
  if (!requestRecord) return NextResponse.json({ error: 'Request not found.' }, { status: 404 });

  if (body.action === 'reset_access') {
    if (requestRecord.status !== 'active') return NextResponse.json({ error: 'Chỉ subdomain đang active mới có access key.' }, { status: 409 });
    const subdomain = await db.query.subdomains.findFirst({ where: eq(subdomains.label, requestRecord.subdomain) });
    if (!subdomain) return NextResponse.json({ error: 'Subdomain chưa được đồng bộ vào panel. Hãy thử lại.' }, { status: 409 });
    const accessKey = createOwnerAccessKey();
    const now = Date.now();
    await db.update(owners).set({ accessKeyHash: hashOwnerAccessKey(accessKey), updatedAt: now }).where(eq(owners.id, subdomain.ownerId));
    await db.delete(ownerSessions).where(eq(ownerSessions.ownerId, subdomain.ownerId));
    await db.insert(dnsEvents).values({ id: crypto.randomUUID(), subdomainId: subdomain.id, actorType: 'admin', action: 'owner_key_reset', details: {}, createdAt: now });
    return NextResponse.json({ ok: true, status: 'active', ownerAccessKey: accessKey, subdomain: `${subdomain.label}.${BASE_DOMAIN}` });
  }

  if (requestRecord.status !== 'pending') return NextResponse.json({ error: 'Only pending requests can be reviewed.' }, { status: 409 });
  const note = body.note?.trim().slice(0, 500) || null;
  if (body.action === 'reject') {
    await db.update(subdomainRequests).set({ status: 'rejected', reviewerNote: note, reviewedAt: Date.now() }).where(eq(subdomainRequests.id, requestRecord.id));
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  const initialRecord: ValidatedDnsRecord = { recordType: 'CNAME', recordName: '@', content: requestRecord.cnameTarget, ttl: 1, proxied: false, priority: null };
  let cloudflareRecordId: string;
  try {
    cloudflareRecordId = await createCloudflareRecord(fullRecordName(requestRecord.subdomain, '@'), initialRecord, `Takeshi Domains request ${requestRecord.id}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare DNS rejected this record.' }, { status: 502 });
  }

  const { owner, accessKey } = await findOrCreateOwner(requestRecord.email, requestRecord.githubHandle);
  const now = Date.now();
  const subdomainId = crypto.randomUUID();
  await db.insert(subdomains).values({ id: subdomainId, label: requestRecord.subdomain, ownerId: owner.id, status: 'active', requestId: requestRecord.id, createdAt: now, updatedAt: now });
  const dnsRecordId = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id: dnsRecordId, subdomainId, recordType: 'CNAME', recordName: '@', content: requestRecord.cnameTarget,
    ttl: 1, proxied: false, priority: null, cloudflareRecordId, createdAt: now, updatedAt: now,
  });
  await db.insert(dnsEvents).values({
    id: crypto.randomUUID(), subdomainId, recordId: dnsRecordId, actorType: 'admin', action: 'record_created',
    details: { type: 'CNAME', name: '@', source: 'approval' }, createdAt: now,
  });
  await db.update(subdomainRequests).set({ status: 'active', reviewerNote: note, reviewedAt: now, cloudflareRecordId }).where(eq(subdomainRequests.id, requestRecord.id));

  return NextResponse.json({ ok: true, status: 'active', recordId: cloudflareRecordId, ownerAccessKey: accessKey, subdomain: `${requestRecord.subdomain}.${BASE_DOMAIN}` });
}
