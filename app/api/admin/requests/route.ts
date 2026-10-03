import { readJson, errorResponse, trustedMutation, validId } from '@/lib/http';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { after, NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb, getSql } from '@/db';
import { dnsEvents, dnsRecords, managedDomains, notificationJobs, owners, ownerSessions, subdomains, subdomainRequests } from '@/db/schema';
import { createCloudflareRecord, deleteCloudflareRecord, findCloudflareRecordByComment } from '@/lib/cloudflare';
import { isAdminAuthorized } from '@/lib/admin-auth';
import { fullRecordName, validateDnsRecord } from '@/lib/dns';
import { createOwnerAccessKey, createRequestAccessKey, hashOwnerAccessKey } from '@/lib/owner-auth';
import { notificationValues, processNotifications, retryNotification } from '@/lib/notifications';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

const REVIEW_LEASE_MS = 10 * 60_000;

function authorized(request: NextRequest) {
  return isAdminAuthorized(request);
}

async function dashboardSummary() {
  const [row] = await getSql().query(`SELECT
    (SELECT count(*)::integer FROM subdomains WHERE status IN ('active','deleting')) AS active,
    (SELECT count(*)::integer FROM subdomain_requests WHERE status='pending') AS pending,
    (SELECT count(*)::integer FROM subdomain_requests) AS requests,
    (SELECT count(*)::integer FROM dns_events) AS events,
    (SELECT count(*)::integer FROM managed_domains) AS domains,
    greatest(
      (SELECT coalesce(max(greatest(created_at, reviewed_at, cancelled_at, released_at, approval_email_sent_at, approval_email_attempted_at)),0) FROM subdomain_requests),
      (SELECT coalesce(max(updated_at),0) FROM subdomains),
      (SELECT coalesce(max(created_at),0) FROM dns_events),
      (SELECT coalesce(max(updated_at),0) FROM managed_domains)
    )::text AS revision`);
  return row;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  await ensureRegistrySchema();
  const tab = request.nextUrl.searchParams.get('tab') ?? 'active-subdomains';
  const page = Number(request.nextUrl.searchParams.get('page') ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > 10_000) return NextResponse.json({ error: 'Invalid page.' }, { status: 400 });
  const db = getDb(), size = 50;
  const detailId = request.nextUrl.searchParams.get('subdomainId');
  if (detailId) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(detailId)) return NextResponse.json({ error: 'Invalid subdomain.' }, { status: 400 });
    const records = await db.select({
      id: dnsRecords.id, recordType: dnsRecords.recordType, recordName: dnsRecords.recordName,
      content: dnsRecords.content, ttl: dnsRecords.ttl, proxied: dnsRecords.proxied, priority: dnsRecords.priority,
      isPrimary: dnsRecords.isPrimary, createdAt: dnsRecords.createdAt, updatedAt: dnsRecords.updatedAt,
    }).from(dnsRecords).where(eq(dnsRecords.subdomainId, detailId)).orderBy(desc(dnsRecords.isPrimary), asc(dnsRecords.recordName), asc(dnsRecords.id)).limit(size + 1).offset(page * size);
    return NextResponse.json({ records: records.slice(0, size), hasMore: records.length > size, page });
  }
  if (!['summary','active-subdomains','pending-requests','request-log','dns-log','domains'].includes(tab)) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const summary = await dashboardSummary();
  if (tab === 'summary') after(async () => {
    try { await processNotifications(undefined, 3); } catch { console.warn('Background notification retry deferred.'); }
  });
  if (tab === 'summary') return NextResponse.json({ summary });
  const payload: Record<string, unknown> = { summary, requests: [], activeSubdomains: [], dnsEvents: [], domains: [], page, pageSize: size };
  let rows: unknown[] = [];
  if (tab === 'pending-requests' || tab === 'request-log') {
    const result = await db.select({ request: { id: subdomainRequests.id, subdomain: subdomainRequests.subdomain, cnameTarget: subdomainRequests.cnameTarget, recordType: subdomainRequests.recordType, recordPriority: subdomainRequests.recordPriority, telegramUsername: subdomainRequests.telegramUsername, notificationEmail: subdomainRequests.notificationEmail, notificationLanguage: subdomainRequests.notificationLanguage, approvalEmailSentAt: subdomainRequests.approvalEmailSentAt, approvalEmailFirstAttemptAt: subdomainRequests.approvalEmailFirstAttemptAt, approvalEmailAttemptedAt: subdomainRequests.approvalEmailAttemptedAt, approvalEmailError: subdomainRequests.approvalEmailError, status: subdomainRequests.status, createdAt: subdomainRequests.createdAt, reviewedAt: subdomainRequests.reviewedAt, cancelledAt: subdomainRequests.cancelledAt, releasedAt: subdomainRequests.releasedAt, reviewerNote: subdomainRequests.reviewerNote }, parentDomain: managedDomains.hostname })
      .from(subdomainRequests).innerJoin(managedDomains, eq(subdomainRequests.parentDomainId, managedDomains.id))
      .where(tab === 'pending-requests' ? eq(subdomainRequests.status, 'pending') : undefined)
      .orderBy(desc(subdomainRequests.createdAt), desc(subdomainRequests.id)).limit(size + 1).offset(page * size);
    rows = result.map(({ request: r, parentDomain }) => ({ ...r, parentDomain }));
    payload.requests = rows.slice(0, size);
  } else if (tab === 'active-subdomains') {
    rows = await db.select({ id: subdomains.id, requestId: subdomains.requestId, label: subdomains.label,
      parentDomain: managedDomains.hostname, status: subdomains.status, createdAt: subdomains.createdAt,
      updatedAt: subdomains.updatedAt, telegramUsername: owners.telegramUsername,
      notificationEmail: subdomainRequests.notificationEmail,
      recordCount: sql<number>`(SELECT count(*)::integer FROM dns_records r WHERE r.subdomain_id = ${subdomains.id} AND NOT r.is_primary)`,
    }).from(subdomains).innerJoin(owners, eq(subdomains.ownerId, owners.id)).innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id)).leftJoin(subdomainRequests, eq(subdomains.requestId, subdomainRequests.id))
      .where(inArray(subdomains.status, ['active', 'deleting'])).orderBy(desc(subdomains.updatedAt), desc(subdomains.id)).limit(size + 1).offset(page * size);
    payload.activeSubdomains = rows.slice(0, size);
  } else if (tab === 'dns-log') {
    rows = await db.select({ id: dnsEvents.id, subdomainId: dnsEvents.subdomainId, domainLabel: dnsEvents.domainLabel,
      parentDomain: dnsEvents.parentDomain, recordId: dnsEvents.recordId, actorType: dnsEvents.actorType,
      action: dnsEvents.action, details: dnsEvents.details, createdAt: dnsEvents.createdAt,
    }).from(dnsEvents).orderBy(desc(dnsEvents.createdAt), desc(dnsEvents.id)).limit(size + 1).offset(page * size);
    payload.dnsEvents = rows.slice(0, size);
  } else {
    rows = await db.select({ id: managedDomains.id, hostname: managedDomains.hostname, status: managedDomains.status,
      createdAt: managedDomains.createdAt, updatedAt: managedDomains.updatedAt,
      // Keep the outer reference qualified: Drizzle's single-table selection
      // otherwise strips the table qualifier, binding "id" to the inner table.
      activeCount: sql<number>`(SELECT count(*)::integer FROM subdomains s WHERE s.parent_domain_id = managed_domains.id AND s.status IN ('active','deleting'))`,
      pendingCount: sql<number>`(SELECT count(*)::integer FROM subdomain_requests r WHERE r.parent_domain_id = managed_domains.id AND r.status='pending')`,
    }).from(managedDomains).orderBy(asc(managedDomains.hostname)).limit(size + 1).offset(page * size);
    payload.domains = rows.slice(0, size);
  }
  payload.hasMore = rows.length > size;
  return NextResponse.json(payload);
}

export async function PATCH(request: NextRequest) {
  if (!trustedMutation(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  let body;
  try { body = await readJson(request) as { id?: string; action?: 'provision' | 'reject' | 'reset_access' | 'retry_email'; note?: string }; } catch (error) { return errorResponse(error); }
  if (!validId(body.id) || typeof body.action !== 'string' || !['provision', 'reject', 'reset_access', 'retry_email'].includes(body.action)) return NextResponse.json({ error: 'Invalid request action.' }, { status: 400 });
  const writeLimit = await enforceRegistryRateLimit(request, 'admin-request-write', 20, 60_000);
  if (!writeLimit.allowed) return NextResponse.json({ error: 'Thao tác quá nhanh. Hãy chờ một phút.' }, { status: 429 });

  await ensureRegistrySchema();
  const db = getDb();
  const requestRecord = await db.query.subdomainRequests.findFirst({ where: eq(subdomainRequests.id, body.id) });
  if (!requestRecord) return NextResponse.json({ error: 'Request not found.' }, { status: 404 });

  if (body.action === 'retry_email') {
    if (requestRecord.status !== 'active' || !requestRecord.notificationEmail) {
      return NextResponse.json({ error: 'Chỉ yêu cầu đã duyệt và có email mới gửi được thư.' }, { status: 409 });
    }
    const limit = await enforceRegistryRateLimit(request, 'admin-retry-approval-email', 10, 60_000);
    if (!limit.allowed) return NextResponse.json({ error: 'Thao tác quá nhanh. Hãy chờ một phút.' }, { status: 429 });
    await retryNotification(requestRecord.id, 'approval');
    after(async () => { try { await processNotifications(requestRecord.id); } catch { console.warn('Approval notification deferred.'); } });
    return NextResponse.json({ ok: true, approvalEmail: 'queued' });
  }

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
    await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, subdomain.ownerId)).for('update');
      if (!owner) throw new Error('Owner no longer active.');
    await tx.update(owners).set({ accessKeyHash: hashOwnerAccessKey(accessKey), updatedAt: now }).where(eq(owners.id, subdomain.ownerId));
    await tx.delete(ownerSessions).where(eq(ownerSessions.ownerId, subdomain.ownerId));
    await tx.insert(dnsEvents).values({
      id: crypto.randomUUID(),
      subdomainId: subdomain.id,
      domainLabel: subdomain.label,
      parentDomain: current.parentDomain,
      actorType: 'admin',
      action: 'owner_key_reset',
      details: { hostname: `${subdomain.label}.${current.parentDomain}` },
      createdAt: now,
    });

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

  const note = typeof body.note === 'string' ? body.note.trim() : '';
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

  const initialRecordResult = validateDnsRecord({
    recordType: claimedRequest.recordType,
    recordName: '@',
    content: claimedRequest.cnameTarget,
    ttl: 1,
    proxied: false,
    priority: claimedRequest.recordPriority,
  });
  if ('error' in initialRecordResult) {
    await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
    return NextResponse.json({ error: `Record chính không hợp lệ: ${initialRecordResult.error}` }, { status: 409 });
  }
  const initialRecord = initialRecordResult.value;
  const requestAccessKey = createRequestAccessKey(claimedRequest.id);
  const systemGeneratedKey = claimedRequest.requestedAccessKeyHash === hashOwnerAccessKey(requestAccessKey);
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

  let accessKey: string | null = systemGeneratedKey ? requestAccessKey : null;
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
        ...initialRecord,
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
        details: { type: initialRecord.recordType, name: '@', priority: initialRecord.priority, isPrimary: true, source: 'approval' },
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
      await tx.insert(notificationJobs).values(notificationValues(claimedRequest.id, ['approval']));
    });
  } catch (error) {
    if (cloudflareRecordCreatedHere) {
      try { await deleteCloudflareRecord(cloudflareRecordId, parentDomain.cloudflareZoneId); } catch { /* The request stays pending so admin can recover it manually. */ }
    }
    await db.update(subdomainRequests).set({ reviewStartedAt: null }).where(eq(subdomainRequests.id, claimedRequest.id));
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Không thể tạo owner cho request này.' }, { status: 409 });
  }

  after(async () => { try { await processNotifications(claimedRequest.id); } catch { console.warn('Approval notification deferred.'); } });
  const approvalEmail = 'queued';
  return NextResponse.json({
    ok: true,
    status: 'active',
    approvalEmail,
    recordId: cloudflareRecordId,
    ownerAccessKey: systemGeneratedKey ? null : accessKey,
    accessKeyProvided: Boolean(claimedRequest.requestedAccessKeyHash) && !systemGeneratedKey,
    subdomain: `${claimedRequest.subdomain}.${parentDomain.hostname}`,
  });
}
