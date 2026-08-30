import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { owners, subdomainRequests } from '@/db/schema';
import { hashOwnerAccessKey } from '@/lib/owner-auth';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';
import { isValidSubdomain, normalizeSubdomain, validateClaim } from '@/lib/registry';
import { notifyAdminOfNewRequest } from '@/lib/telegram';

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
  if (!subdomain) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });
  if (!isValidSubdomain(subdomain)) return NextResponse.json({ error: 'Invalid subdomain.' }, { status: 400 });

  const limit = await enforceRegistryRateLimit(request, 'availability-check', 15, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many name checks. Please try again shortly.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  await ensureRegistrySchema();
  const existing = await getDb().query.subdomainRequests.findFirst({
    where: and(eq(subdomainRequests.subdomain, subdomain), inArray(subdomainRequests.status, RESERVED_STATUSES)),
    columns: { id: true },
  });
  return NextResponse.json({ subdomain, available: !existing });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }

  const claimInput = body !== null && typeof body === 'object'
    ? body as Parameters<typeof validateClaim>[0]
    : {};
  const result = validateClaim(claimInput);
  if ('error' in result) return NextResponse.json(result, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const now = Date.now();
  const accessKeyHash = hashOwnerAccessKey(result.value.accessKey);
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
    where: and(eq(subdomainRequests.subdomain, result.value.subdomain), inArray(subdomainRequests.status, RESERVED_STATUSES)),
    columns: { id: true },
  });
  if (existing) return NextResponse.json({ error: 'Subdomain này đã có người đăng ký hoặc đang chờ duyệt.', field: 'subdomain' }, { status: 409 });

  const keyInUse = await db.query.owners.findFirst({ where: eq(owners.accessKeyHash, accessKeyHash), columns: { id: true } });
  if (keyInUse) return NextResponse.json({ error: 'Access key này đã được dùng. Hãy chọn key khác.', field: 'accessKey' }, { status: 409 });
  const pendingKey = await db.query.subdomainRequests.findFirst({
    where: and(eq(subdomainRequests.requestedAccessKeyHash, accessKeyHash), inArray(subdomainRequests.status, RESERVED_STATUSES)),
    columns: { id: true },
  });
  if (pendingKey) return NextResponse.json({ error: 'Access key này đang được dùng cho một request khác. Hãy chọn key khác.', field: 'accessKey' }, { status: 409 });

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

  const id = crypto.randomUUID();
  try {
    await db.insert(subdomainRequests).values({
      id,
      subdomain: result.value.subdomain,
      cnameTarget: result.value.cnameTarget,
      githubHandle: null,
      email: `telegram:${result.value.telegramUsername}`,
      telegramUsername: result.value.telegramUsername,
      requestedAccessKeyHash: accessKeyHash,
      status: 'pending',
      createdAt: now,
    });
  } catch (error) {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: 'Subdomain hoặc access key vừa được dùng bởi một request khác. Hãy kiểm tra lại.' }, { status: 409 });
    }
    throw error;
  }

  // A delivery failure must never invalidate a successfully stored request.
  await notifyAdminOfNewRequest({
    requestId: id,
    subdomain: result.value.subdomain,
    cnameTarget: result.value.cnameTarget,
    telegramUsername: result.value.telegramUsername,
  });

  return NextResponse.json({ ok: true, requestId: id, status: 'pending' }, { status: 201 });
}
