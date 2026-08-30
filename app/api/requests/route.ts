import { and, count, eq, gt, ne } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { ensureRegistrySchema, getDb } from '@/db';
import { owners, subdomainRequests } from '@/db/schema';
import { hashOwnerAccessKey } from '@/lib/owner-auth';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';
import { isValidSubdomain, normalizeSubdomain, validateClaim } from '@/lib/registry';

export async function GET(request: NextRequest) {
  const subdomain = normalizeSubdomain(request.nextUrl.searchParams.get('subdomain') ?? '');
  if (!subdomain) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });
  if (!isValidSubdomain(subdomain)) return NextResponse.json({ error: 'Invalid subdomain.' }, { status: 400 });

  const limit = await enforceRegistryRateLimit(request, 'availability-check', 15, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many name checks. Please try again shortly.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  const db = getDb();
  const existing = await db.query.subdomainRequests.findFirst({
    where: eq(subdomainRequests.subdomain, subdomain),
    columns: { status: true },
  });
  return NextResponse.json({ subdomain, available: !existing || existing.status === 'rejected' });
}

export async function POST(request: NextRequest) {
  const limit = await enforceRegistryRateLimit(request, 'request-submit', 6, 86_400_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many requests from this network today. Please try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }

  const result = validateClaim(body as Parameters<typeof validateClaim>[0]);
  if ('error' in result) return NextResponse.json(result, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const now = Date.now();
  const accessKeyHash = hashOwnerAccessKey(result.value.accessKey);
  const [{ value: requestCount }] = await db
    .select({ value: count() })
    .from(subdomainRequests)
    .where(and(eq(subdomainRequests.telegramUsername, result.value.telegramUsername), gt(subdomainRequests.createdAt, now - 86_400_000)));

  if (requestCount >= 3) return NextResponse.json({ error: 'Telegram này đã gửi quá nhiều request hôm nay. Hãy thử lại sau.', field: 'telegramUsername' }, { status: 429 });

  const existing = await db.query.subdomainRequests.findFirst({
    where: eq(subdomainRequests.subdomain, result.value.subdomain),
    columns: { id: true, status: true },
  });
  if (existing && existing.status !== 'rejected') return NextResponse.json({ error: 'Subdomain này đã có người đăng ký hoặc đang chờ duyệt.', field: 'subdomain' }, { status: 409 });

  const keyInUse = await db.query.owners.findFirst({ where: eq(owners.accessKeyHash, accessKeyHash), columns: { id: true } });
  if (keyInUse) return NextResponse.json({ error: 'Access key này đã được dùng. Hãy chọn key khác.', field: 'accessKey' }, { status: 409 });
  const pendingKey = await db.query.subdomainRequests.findFirst({
    where: and(eq(subdomainRequests.requestedAccessKeyHash, accessKeyHash), ne(subdomainRequests.status, 'rejected')),
    columns: { id: true },
  });
  if (pendingKey && pendingKey.id !== existing?.id) return NextResponse.json({ error: 'Access key này đang được dùng cho một request khác. Hãy chọn key khác.', field: 'accessKey' }, { status: 409 });

  const id = crypto.randomUUID();
  if (existing?.status === 'rejected') {
    await db.update(subdomainRequests).set({ cnameTarget: result.value.cnameTarget, githubHandle: null, email: `telegram:${result.value.telegramUsername}`, telegramUsername: result.value.telegramUsername, requestedAccessKeyHash: accessKeyHash, status: 'pending', createdAt: now, reviewedAt: null, reviewerNote: null, cloudflareRecordId: null }).where(eq(subdomainRequests.subdomain, result.value.subdomain));
  } else {
    await db.insert(subdomainRequests).values({ id, subdomain: result.value.subdomain, cnameTarget: result.value.cnameTarget, githubHandle: null, email: `telegram:${result.value.telegramUsername}`, telegramUsername: result.value.telegramUsername, requestedAccessKeyHash: accessKeyHash, status: 'pending', createdAt: now });
  }
  return NextResponse.json({ ok: true, requestId: existing ? result.value.subdomain : id, status: 'pending' }, { status: 201 });
}
