import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { dnsEvents, dnsRecords, managedDomains, owners, ownerSessions, subdomains, subdomainRequests } from '@/db/schema';
import { createCloudflareRecord, deleteCloudflareRecord, findCloudflareRecordByComment } from '@/lib/cloudflare';
import { isAdminAuthorized } from '@/lib/admin-auth';
import { fullRecordName, type ValidatedDnsRecord } from '@/lib/dns';
import { createOwnerAccessKey, hashOwnerAccessKey } from '@/lib/owner-auth';

const REVIEW_LEASE_MS = 10 * 60_000;

// Deliberately omit Cloudflare's record ID here. The admin dashboard needs the
// DNS configuration for inspection, but it never needs a provider credential
// or provider-side identifier to render a subdomain's details.
type AdminDnsRecord = {
  id: string;
  recordType: string;
  recordName: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
};

function authorized(request: NextRequest) {
  return isAdminAuthorized(request);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  await ensureRegistrySchema();
  const db = getDb();
  const [requestRows, activeRows, eventRows, registryDomains, subdomainCounts, pendingCounts] = await Promise.all([
    db.select({ request: subdomainRequests, parentDomain: managedDomains.hostname })
      .from(subdomainRequests)
      .innerJoin(managedDomains, eq(subdomainRequests.parentDomainId, managedDomains.id))
      .orderBy(desc(subdomainRequests.createdAt))
      .limit(500),
    db
      .select({
        id: subdomains.id,
        requestId: subdomains.requestId,
        label: subdomains.label,
        parentDomain: managedDomains.hostname,
        status: subdomains.status,
        createdAt: subdomains.createdAt,
        updatedAt: subdomains.updatedAt,
        telegramUsername: owners.telegramUsername,
      })
      .from(subdomains)
      .innerJoin(owners, eq(subdomains.ownerId, owners.id))
      .innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id))
      .where(eq(subdomains.status, 'active'))
      .orderBy(desc(subdomains.updatedAt)),
    db
      .select({
        id: dnsEvents.id,
        subdomainId: dnsEvents.subdomainId,
        domainLabel: dnsEvents.domainLabel,
        parentDomain: dnsEvents.parentDomain,
        currentDomainLabel: subdomains.label,
        recordId: dnsEvents.recordId,
        actorType: dnsEvents.actorType,
        action: dnsEvents.action,
        details: dnsEvents.details,
        createdAt: dnsEvents.createdAt,
      })
      .from(dnsEvents)
      .leftJoin(subdomains, eq(dnsEvents.subdomainId, subdomains.id))
      .orderBy(desc(dnsEvents.createdAt))
      .limit(300),
    db.select().from(managedDomains).orderBy(asc(managedDomains.hostname)),
    db.select({ parentDomainId: subdomains.parentDomainId, value: count() })
      .from(subdomains)
      .where(eq(subdomains.status, 'active'))
      .groupBy(subdomains.parentDomainId),
    db.select({ parentDomainId: subdomainRequests.parentDomainId, value: count() })
      .from(subdomainRequests)
      .where(eq(subdomainRequests.status, 'pending'))
      .groupBy(subdomainRequests.parentDomainId),
  ]);

  const domainIds = activeRows.map((domain) => domain.id);
  const recordRows: Array<AdminDnsRecord & { subdomainId: string }> = domainIds.length === 0
    ? []
    : await db
      .select({
        id: dnsRecords.id,
        subdomainId: dnsRecords.subdomainId,
        recordType: dnsRecords.recordType,
        recordName: dnsRecords.recordName,
        content: dnsRecords.content,
        ttl: dnsRecords.ttl,
        proxied: dnsRecords.proxied,
        priority: dnsRecords.priority,
        isPrimary: dnsRecords.isPrimary,
        createdAt: dnsRecords.createdAt,
        updatedAt: dnsRecords.updatedAt,
      })
      .from(dnsRecords)
      .where(inArray(dnsRecords.subdomainId, domainIds))
      .orderBy(desc(dnsRecords.isPrimary), asc(dnsRecords.recordName), asc(dnsRecords.recordType));
  const recordCounts = new Map<string, number>();
  const recordsBySubdomain = new Map<string, AdminDnsRecord[]>();
  for (const record of recordRows) {
    if (!record.isPrimary) recordCounts.set(record.subdomainId, (recordCounts.get(record.subdomainId) ?? 0) + 1);
    const { subdomainId, ...recordForDashboard } = record;
    const records = recordsBySubdomain.get(subdomainId) ?? [];
    records.push(recordForDashboard);
    recordsBySubdomain.set(subdomainId, records);
  }
  const activeCounts = new Map(subdomainCounts.map((row) => [row.parentDomainId, Number(row.value)]));
  const pendingByDomain = new Map(pendingCounts.map((row) => [row.parentDomainId, Number(row.value)]));

  return NextResponse.json({
    requests: requestRows.map(({ request: requestRecord, parentDomain }) => ({ ...requestRecord, parentDomain })),
    activeSubdomains: activeRows.map((domain) => ({
      ...domain,
      recordCount: recordCounts.get(domain.id) ?? 0,
      records: recordsBySubdomain.get(domain.id) ?? [],
    })),
    dnsEvents: eventRows,
    domains: registryDomains.map((domain) => ({
      id: domain.id,
      hostname: domain.hostname,
      status: domain.status,
      activeCount: activeCounts.get(domain.id) ?? 0,
      pendingCount: pendingByDomain.get(domain.id) ?? 0,
      createdAt: domain.createdAt,
      updatedAt: domain.updatedAt,
    })),
  });
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
    const rows = await db
      .select({ subdomain: subdomains, parentDomain: managedDomains.hostname })
      .from(subdomains)
      .innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id))
      .where(eq(subdomains.requestId, requestRecord.id))
      .limit(1);
    const current = rows[0];
    if (!current) return NextResponse.json({ error: 'Subdomain chưa được đồng bộ vào panel. Hãy thử lại.' }, { status: 409 });
    const subdomain = current.subdomain;
    const accessKey = createOwnerAccessKey();
    const now = Date.now();
    await db.update(owners).set({ accessKeyHash: hashOwnerAccessKey(accessKey), updatedAt: now }).where(eq(owners.id, subdomain.ownerId));
    await db.delete(ownerSessions).where(eq(ownerSessions.ownerId, subdomain.ownerId));
    await db.insert(dnsEvents).values({
      id: crypto.randomUUID(),
      subdomainId: subdomain.id,
      domainLabel: subdomain.label,
      parentDomain: current.parentDomain,
      actorType: 'admin',
      action: 'owner_key_reset',
      details: { hostname: `${subdomain.label}.${current.parentDomain}` },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, status: 'active', ownerAccessKey: accessKey, subdomain: `${subdomain.label}.${current.parentDomain}` });
  }

  const now = Date.now();
  if (requestRecord.status === 'pending' && requestRecord.reviewStartedAt) {
    if (requestRecord.reviewStartedAt > now - REVIEW_LEASE_MS) {
      return NextResponse.json({ error: 'Request này đang được triển khai. Hãy chờ ít phút rồi tải lại.' }, { status: 409 });
    }
    const releasedLease = await db
      .update(subdomainRequests)
      .set({ reviewStartedAt: null })
      .where(and(
        eq(subdomainRequests.id, requestRecord.id),
        eq(subdomainRequests.status, 'pending'),
        eq(subdomainRequests.reviewStartedAt, requestRecord.reviewStartedAt),
      ))
      .returning({ id: subdomainRequests.id });
    if (releasedLease.length === 0) return NextResponse.json({ error: 'Trạng thái request vừa thay đổi. Hãy tải lại dashboard.' }, { status: 409 });
  }

  const note = body.note?.trim() ?? '';
  if (note.length > 500) return NextResponse.json({ error: 'Lý do chỉ được tối đa 500 ký tự.' }, { status: 400 });
  if (body.action === 'reject') {
    if (note.length < 3) return NextResponse.json({ error: 'Hãy nhập lý do từ chối ít nhất 3 ký tự.' }, { status: 400 });
    const rejected = await db
      .update(subdomainRequests)
      .set({ status: 'rejected', reviewerNote: note, reviewedAt: now })
      .where(and(eq(subdomainRequests.id, requestRecord.id), eq(subdomainRequests.status, 'pending'), isNull(subdomainRequests.reviewStartedAt)))
      .returning({ id: subdomainRequests.id });
    if (rejected.length === 0) return NextResponse.json({ error: 'Yêu cầu đã đổi trạng thái hoặc đang được duyệt.' }, { status: 409 });
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  if (body.action !== 'provision') return NextResponse.json({ error: 'Unknown request action.' }, { status: 400 });

  // Claim the request before calling Cloudflare. A user cannot cancel once this
  // succeeds, preventing a cancelled request from being provisioned concurrently.
  const claimed = await db
    .update(subdomainRequests)
    .set({ reviewStartedAt: now })
    .where(and(eq(subdomainRequests.id, requestRecord.id), eq(subdomainRequests.status, 'pending'), isNull(subdomainRequests.reviewStartedAt)))
    .returning();
  const claimedRequest = claimed[0];
  if (!claimedRequest) return NextResponse.json({ error: 'Yêu cầu đã đổi trạng thái hoặc đang được xử lý.' }, { status: 409 });

  if (claimedRequest.requestedAccessKeyHash) {
    const keyInUse = await db.query.owners.findFirst({ where: eq(owners.accessKeyHash, claimedRequest.requestedAccessKeyHash), columns: { id: true } });
    if (keyInUse) {
      await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
      return NextResponse.json({ error: 'Access key này đã được dùng bởi một owner khác.' }, { status: 409 });
    }
  }

  const parentDomain = await db.query.managedDomains.findFirst({
    where: eq(managedDomains.id, claimedRequest.parentDomainId),
  });
  if (!parentDomain || parentDomain.status !== 'active' || !parentDomain.cloudflareZoneId) {
    await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
    return NextResponse.json({ error: 'Domain gốc này không còn active hoặc chưa có Cloudflare zone ID. Kiểm tra tab Domains trước khi duyệt.' }, { status: 409 });
  }

  const initialRecord: ValidatedDnsRecord = { recordType: 'CNAME', recordName: '@', content: claimedRequest.cnameTarget, ttl: 1, proxied: false, priority: null };
  const cloudflareComment = `Takeshi Domains request ${claimedRequest.id}`;
  let cloudflareRecordId: string;
  let cloudflareRecordCreatedHere = false;
  try {
    const existingRecordId = await findCloudflareRecordByComment(
      fullRecordName(claimedRequest.subdomain, '@', parentDomain.hostname),
      initialRecord,
      cloudflareComment,
      parentDomain.cloudflareZoneId,
    );
    if (existingRecordId) {
      cloudflareRecordId = existingRecordId;
    } else {
      cloudflareRecordId = await createCloudflareRecord(
        fullRecordName(claimedRequest.subdomain, '@', parentDomain.hostname),
        initialRecord,
        cloudflareComment,
        parentDomain.cloudflareZoneId,
      );
      cloudflareRecordCreatedHere = true;
    }
  } catch (error) {
    await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare DNS rejected this record.' }, { status: 502 });
  }

  let accessKey: string | null = null;
  try {
    await db.transaction(async (tx) => {
      let owner: typeof owners.$inferSelect;
      if (claimedRequest.requestedAccessKeyHash) {
        owner = {
          id: crypto.randomUUID(),
          email: `owner:${claimedRequest.id}`,
          githubHandle: null,
          telegramUsername: claimedRequest.telegramUsername,
          accessKeyHash: claimedRequest.requestedAccessKeyHash,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(owners).values(owner);
      } else {
        const existingOwner = await tx.query.owners.findFirst({ where: eq(owners.email, claimedRequest.email) });
        if (!existingOwner) {
          accessKey = createOwnerAccessKey();
          owner = {
            id: crypto.randomUUID(),
            email: claimedRequest.email,
            githubHandle: claimedRequest.githubHandle,
            telegramUsername: null,
            accessKeyHash: hashOwnerAccessKey(accessKey),
            status: 'active',
            createdAt: now,
            updatedAt: now,
          };
          await tx.insert(owners).values(owner);
        } else {
          owner = existingOwner;
          if (!owner.accessKeyHash) {
            accessKey = createOwnerAccessKey();
            const accessKeyHash = hashOwnerAccessKey(accessKey);
            await tx.update(owners).set({ accessKeyHash, updatedAt: now }).where(eq(owners.id, owner.id));
            owner = { ...owner, accessKeyHash, updatedAt: now };
          }
        }
      }

      const subdomainId = crypto.randomUUID();
      await tx.insert(subdomains).values({
        id: subdomainId,
        label: claimedRequest.subdomain,
        parentDomainId: parentDomain.id,
        ownerId: owner.id,
        status: 'active',
        requestId: claimedRequest.id,
        createdAt: now,
        updatedAt: now,
      });
      const dnsRecordId = crypto.randomUUID();
      await tx.insert(dnsRecords).values({
        id: dnsRecordId,
        subdomainId,
        recordType: 'CNAME',
        recordName: '@',
        content: claimedRequest.cnameTarget,
        ttl: 1,
        proxied: false,
        priority: null,
        isPrimary: true,
        cloudflareRecordId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(dnsEvents).values({
        id: crypto.randomUUID(),
        subdomainId,
        domainLabel: claimedRequest.subdomain,
        parentDomain: parentDomain.hostname,
        recordId: dnsRecordId,
        actorType: 'admin',
        action: 'primary_record_created',
        details: { type: 'CNAME', name: '@', isPrimary: true, source: 'approval' },
        createdAt: now,
      });
      const activated = await tx.update(subdomainRequests).set({
        status: 'active',
        reviewerNote: note || null,
        reviewedAt: now,
        reviewStartedAt: null,
        cloudflareRecordId,
      }).where(and(eq(subdomainRequests.id, claimedRequest.id), eq(subdomainRequests.status, 'pending'))).returning({ id: subdomainRequests.id });
      if (activated.length === 0) throw new Error('Request status changed before DNS activation finished.');
    });
  } catch (error) {
    if (cloudflareRecordCreatedHere) {
      try { await deleteCloudflareRecord(cloudflareRecordId, parentDomain.cloudflareZoneId); } catch { /* The request stays pending so admin can recover it manually. */ }
    }
    await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Không thể tạo owner cho request này.' }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    status: 'active',
    recordId: cloudflareRecordId,
    ownerAccessKey: accessKey,
    accessKeyProvided: Boolean(claimedRequest.requestedAccessKeyHash),
    subdomain: `${claimedRequest.subdomain}.${parentDomain.hostname}`,
  });
}
