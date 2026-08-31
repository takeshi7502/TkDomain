import { and, asc, count, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { managedDomains, subdomainRequests, subdomains } from '@/db/schema';
import { findCloudflareZoneByName } from '@/lib/cloudflare';
import { isAdminAuthorized } from '@/lib/admin-auth';
import { isValidParentDomain, normalizeParentDomain } from '@/lib/registry';

function authorized(request: NextRequest) {
  return isAdminAuthorized(request);
}

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

function overlapsExistingZone(candidate: string, existing: string) {
  return candidate === existing || candidate.endsWith(`.${existing}`) || existing.endsWith(`.${candidate}`);
}

async function listDomains() {
  const db = getDb();
  const [domains, subdomainCounts, pendingCounts] = await Promise.all([
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
  const activeCounts = new Map(subdomainCounts.map((row) => [row.parentDomainId, Number(row.value)]));
  const pending = new Map(pendingCounts.map((row) => [row.parentDomainId, Number(row.value)]));
  return domains.map((domain) => ({
    id: domain.id,
    hostname: domain.hostname,
    status: domain.status,
    activeCount: activeCounts.get(domain.id) ?? 0,
    pendingCount: pending.get(domain.id) ?? 0,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  }));
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  await ensureRegistrySchema();
  return NextResponse.json({ domains: await listDomains() });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  let body: { hostname?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  const hostname = typeof body.hostname === 'string' ? normalizeParentDomain(body.hostname) : '';
  if (!isValidParentDomain(hostname)) return NextResponse.json({ error: 'Tên domain gốc không hợp lệ.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const existingDomains = await db.select().from(managedDomains);
  const exact = existingDomains.find((domain) => domain.hostname === hostname);
  const conflict = existingDomains.find((domain) => domain.hostname !== hostname && overlapsExistingZone(hostname, domain.hostname));
  if (conflict) {
    return NextResponse.json({ error: `Không thể thêm ${hostname} vì zone này chồng với ${conflict.hostname} đã có trong registry.` }, { status: 409 });
  }
  if (exact?.status === 'active') return NextResponse.json({ error: 'Domain này đang có trong registry.' }, { status: 409 });

  let zone;
  try {
    zone = await findCloudflareZoneByName(hostname);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Không thể kiểm tra Cloudflare zone.' }, { status: 502 });
  }
  if (!zone) {
    return NextResponse.json({
      error: 'Không tìm thấy Cloudflare zone active cho domain này. Kiểm tra domain đã active và token có Zone:Read trên zone đó.',
    }, { status: 404 });
  }

  const now = Date.now();
  if (exact) {
    await db.update(managedDomains)
      .set({ status: 'active', cloudflareZoneId: zone.id, updatedAt: now })
      .where(eq(managedDomains.id, exact.id));
  } else {
    await db.insert(managedDomains).values({
      id: crypto.randomUUID(),
      hostname,
      cloudflareZoneId: zone.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  return NextResponse.json({ ok: true, domains: await listDomains() }, { status: exact ? 200 : 201 });
}

/**
 * Removing a parent domain is an archive, not a Cloudflare-zone deletion. It
 * immediately hides the domain from public registration while preserving audit
 * history. Active subdomains and pending claims must be resolved first.
 */
export async function DELETE(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Missing domain.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const domain = await db.query.managedDomains.findFirst({ where: eq(managedDomains.id, id) });
  if (!domain) return NextResponse.json({ error: 'Domain không tồn tại.' }, { status: 404 });
  if (domain.status === 'archived') return NextResponse.json({ ok: true, domains: await listDomains() });

  const [[subdomainCount], [pendingCount]] = await Promise.all([
    db.select({ value: count() }).from(subdomains).where(eq(subdomains.parentDomainId, domain.id)),
    db.select({ value: count() }).from(subdomainRequests)
      .where(and(eq(subdomainRequests.parentDomainId, domain.id), eq(subdomainRequests.status, 'pending'))),
  ]);
  const attachedSubdomains = Number(subdomainCount?.value ?? 0);
  const pendingRequests = Number(pendingCount?.value ?? 0);
  if (attachedSubdomains > 0 || pendingRequests > 0) {
    return NextResponse.json({
      error: `Không thể gỡ ${domain.hostname}: còn ${attachedSubdomains} subdomain và ${pendingRequests} yêu cầu chờ duyệt.`,
    }, { status: 409 });
  }

  await db.update(managedDomains).set({ status: 'archived', updatedAt: Date.now() }).where(eq(managedDomains.id, domain.id));
  return NextResponse.json({ ok: true, domains: await listDomains() });
}
