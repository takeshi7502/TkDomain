import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { after, NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { managedDomains, notificationJobs, pendingRequestSessions, subdomainRequests } from '@/db/schema';
import { createPendingRequestSessionRecord, createRequestAccessKey, hashOwnerAccessKey, setPendingRequestSessionCookie } from '@/lib/owner-auth';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import { isValidSubdomain, normalizeSubdomain, validateClaim } from '@/lib/registry';
import { notificationValues, processNotifications } from '@/lib/notifications';
import { errorResponse, HttpError, readJson } from '@/lib/http';

const RESERVED_STATUSES = ['pending', 'active'] as const;
const REQUEST_IP_LIMIT = 10;
const REQUEST_IP_WINDOW_MS = 60 * 60_000;
const TELEGRAM_REQUEST_LIMIT = 3;
const TELEGRAM_REQUEST_WINDOW_MS = 24 * 60 * 60_000;

function retryAfterResponse(error: string, retryAfterSeconds: number, field?: string) {
  return NextResponse.json(
    { error, retryAfterSeconds, ...(field ? { field } : {}) },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function GET(request: NextRequest) {
  const subdomain = normalizeSubdomain(request.nextUrl.searchParams.get('subdomain') ?? '');
  const parentDomainId = request.nextUrl.searchParams.get('domainId')?.trim() ?? '';
  if (!subdomain) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });
  if (!isValidSubdomain(subdomain)) return NextResponse.json({ error: 'Invalid subdomain.' }, { status: 400 });
  if (!parentDomainId || parentDomainId.length > 120) return NextResponse.json({ error: 'Missing parent domain.' }, { status: 400 });

  const limit = await enforceRegistryRateLimit(request, 'availability-check', 15, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many name checks. Please try again shortly.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  await ensureRegistrySchema();
  const db = getDb();
  const parentDomain = await db.query.managedDomains.findFirst({
    where: and(eq(managedDomains.id, parentDomainId), eq(managedDomains.status, 'active')),
  });
  if (!parentDomain || !parentDomain.cloudflareZoneId) return NextResponse.json({ error: 'Tên miền này không còn nhận đăng ký.' }, { status: 404 });
  const existing = await db.query.subdomainRequests.findFirst({
    where: and(
      eq(subdomainRequests.parentDomainId, parentDomain.id),
      eq(subdomainRequests.subdomain, subdomain),
      inArray(subdomainRequests.status, RESERVED_STATUSES),
    ),
    columns: { id: true },
  });
  return NextResponse.json({ subdomain, parentDomain: parentDomain.hostname, available: !existing });
}

export async function POST(request: NextRequest) {
  const attemptLimit = await enforceRegistryRateLimit(request, 'request-attempt', 30, 60_000);
  if (!attemptLimit.allowed) return retryAfterResponse('Quá nhiều lượt gửi. Hãy chờ một phút.', attemptLimit.retryAfterSeconds);
  let body: unknown;
  try { body = await readJson(request); } catch (error) { return errorResponse(error); }

  const claimInput = body !== null && typeof body === 'object'
    ? body as Parameters<typeof validateClaim>[0]
    : {};

  await ensureRegistrySchema();
  const db = getDb();
  const requestedParentId = typeof claimInput.parentDomainId === 'string' ? claimInput.parentDomainId.trim() : '';
  if (!requestedParentId || requestedParentId.length > 120) {
    return NextResponse.json({ error: 'Hãy chọn một domain để đăng ký.', field: 'parentDomainId' }, { status: 400 });
  }
  const [parentDomain, activeDomains] = await Promise.all([
    db.query.managedDomains.findFirst({
      where: and(eq(managedDomains.id, requestedParentId), eq(managedDomains.status, 'active')),
    }),
    db.select({ hostname: managedDomains.hostname }).from(managedDomains).where(eq(managedDomains.status, 'active')),
  ]);
  if (!parentDomain || !parentDomain.cloudflareZoneId) {
    return NextResponse.json({ error: 'Domain đã chọn không còn nhận đăng ký. Hãy tải lại trang và chọn domain khác.', field: 'parentDomainId' }, { status: 409 });
  }
  const result = validateClaim(claimInput, activeDomains.map((domain) => domain.hostname));
  if ('error' in result) return NextResponse.json(result, { status: 400 });

  const now = Date.now();
  const recentTelegramRequests = await db
    .select({ createdAt: subdomainRequests.createdAt })
    .from(subdomainRequests)
    .where(and(
      eq(subdomainRequests.telegramUsername, result.value.telegramUsername),
      gt(subdomainRequests.createdAt, now - TELEGRAM_REQUEST_WINDOW_MS),
    ))
    .orderBy(asc(subdomainRequests.createdAt))
    .limit(TELEGRAM_REQUEST_LIMIT);

  if (recentTelegramRequests.length >= TELEGRAM_REQUEST_LIMIT) {
    const oldestRequestAt = Number(recentTelegramRequests[0]?.createdAt ?? now);
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestRequestAt + TELEGRAM_REQUEST_WINDOW_MS - now) / 1_000));
    return retryAfterResponse(
      'Telegram này đã gửi tối đa 3 yêu cầu trong 24 giờ gần nhất. Hãy thử lại sau khi thời gian chờ kết thúc.',
      retryAfterSeconds,
      'telegramUsername',
    );
  }

  const existing = await db.query.subdomainRequests.findFirst({
    where: and(
      eq(subdomainRequests.parentDomainId, parentDomain.id),
      eq(subdomainRequests.subdomain, result.value.subdomain),
      inArray(subdomainRequests.status, RESERVED_STATUSES),
    ),
    columns: { id: true },
  });
  if (existing) return NextResponse.json({ error: 'Subdomain này đã có người đăng ký hoặc đang chờ duyệt.', field: 'subdomain' }, { status: 409 });

  // Only a request that has passed validation and all conflict checks consumes
  // an IP quota. This keeps typos, already-taken names, and test retries from
  // locking a user out. The v2 key deliberately starts a fresh bucket instead
  // of inheriting the previous 6-per-day counter stored in production.
  const ipLimit = await enforceRegistryRateLimit(
    request,
    'request-submit-valid-v2',
    REQUEST_IP_LIMIT,
    REQUEST_IP_WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    return retryAfterResponse(
      'Bạn đã gửi quá nhiều yêu cầu hợp lệ từ mạng này. Hãy chờ một lúc rồi thử lại.',
      ipLimit.retryAfterSeconds,
    );
  }

  const globalLimit = await enforceRegistryScopedRateLimit('request-submit-global', 'registry', 60, 24 * 60 * 60_000);
  if (!globalLimit.allowed) return retryAfterResponse('Registry đã đạt hạn mức đăng ký hôm nay. Hãy thử lại sau.', globalLimit.retryAfterSeconds);
  const id = crypto.randomUUID();
  const accessKeyHash = hashOwnerAccessKey(createRequestAccessKey(id));
  const pendingSession = createPendingRequestSessionRecord(id);
  try {
    await db.transaction(async (tx) => {
      const [currentParent] = await tx.select({ status: managedDomains.status }).from(managedDomains).where(eq(managedDomains.id, parentDomain.id)).for('share');
      if (currentParent?.status !== 'active') throw new HttpError('Domain đã ngừng nhận đăng ký. Hãy chọn domain khác.', 409);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'claim-telegram:' + result.value.telegramUsername}, 0))`);
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::integer` }).from(subdomainRequests)
        .where(and(eq(subdomainRequests.telegramUsername, result.value.telegramUsername), gt(subdomainRequests.createdAt, now - TELEGRAM_REQUEST_WINDOW_MS)));
      if (total >= TELEGRAM_REQUEST_LIMIT) throw new HttpError('Telegram này đã đạt hạn mức đăng ký trong 24 giờ.', 429);
      await tx.insert(subdomainRequests).values({
      id,
      subdomain: result.value.subdomain,
      parentDomainId: parentDomain.id,
      cnameTarget: result.value.recordContent,
      recordType: result.value.recordType,
      recordPriority: result.value.recordPriority,
      githubHandle: null,
      email: `telegram:${result.value.telegramUsername}`,
      notificationEmail: result.value.notificationEmail,
      notificationLanguage: result.value.notificationLanguage,
      telegramUsername: result.value.telegramUsername,
      requestedAccessKeyHash: accessKeyHash,
      status: 'pending',
      createdAt: now,
      });
      await tx.insert(notificationJobs).values(notificationValues(id, ['receipt', 'admin_telegram']));
      await tx.insert(pendingRequestSessions).values(pendingSession.record);
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: 'Subdomain vừa được đăng ký bởi một request khác. Hãy kiểm tra lại.' }, { status: 409 });
    }
    throw error;
  }

  // The registering browser can still view/cancel this pending request without
  // knowing the owner key, which is only delivered after approval.

  // Jobs are already committed with the request. Response does not wait for providers.
  after(async () => { try { await processNotifications(id); } catch { console.warn('Registration notifications deferred.'); } });
  const response = NextResponse.json({ ok: true, requestId: id, status: 'pending', requestEmail: 'queued' }, { status: 201 });
  setPendingRequestSessionCookie(response, pendingSession.token);
  return response;
}
