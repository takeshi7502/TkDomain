import { and, count, eq, gt } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { ensureRegistrySchema, getDb } from '@/db';
import { subdomainRequests } from '@/db/schema';
import { normalizeSubdomain, validateClaim } from '@/lib/registry';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const subdomain = normalizeSubdomain(request.nextUrl.searchParams.get('subdomain') ?? '');
  if (!subdomain) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const existing = await db.query.subdomainRequests.findFirst({
    where: eq(subdomainRequests.subdomain, subdomain),
    columns: { status: true },
  });
  return NextResponse.json({ subdomain, available: !existing || existing.status === 'rejected' });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }

  const result = validateClaim(body as Parameters<typeof validateClaim>[0]);
  if ('error' in result) return NextResponse.json(result, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const now = Date.now();
  const [{ value: requestCount }] = await db
    .select({ value: count() })
    .from(subdomainRequests)
    .where(and(eq(subdomainRequests.email, result.value.email), gt(subdomainRequests.createdAt, now - 86_400_000)));

  if (requestCount >= 3) return NextResponse.json({ error: 'Email này đã gửi quá nhiều request hôm nay. Hãy thử lại sau.' }, { status: 429 });

  const existing = await db.query.subdomainRequests.findFirst({
    where: eq(subdomainRequests.subdomain, result.value.subdomain),
    columns: { status: true },
  });
  if (existing && existing.status !== 'rejected') return NextResponse.json({ error: 'Subdomain này đã có người đăng ký hoặc đang chờ duyệt.' }, { status: 409 });

  const id = crypto.randomUUID();
  if (existing?.status === 'rejected') {
    await db.update(subdomainRequests).set({ cnameTarget: result.value.cnameTarget, githubHandle: result.value.githubHandle, email: result.value.email, status: 'pending', createdAt: now, reviewedAt: null, reviewerNote: null, cloudflareRecordId: null }).where(eq(subdomainRequests.subdomain, result.value.subdomain));
  } else {
    await db.insert(subdomainRequests).values({ id, ...result.value, status: 'pending', createdAt: now });
  }
  return NextResponse.json({ ok: true, requestId: existing ? result.value.subdomain : id, status: 'pending' }, { status: 201 });
}
