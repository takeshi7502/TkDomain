import { desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { ensureRegistrySchema, getDb } from '@/db';
import { subdomainRequests } from '@/db/schema';
import { BASE_DOMAIN } from '@/lib/registry';

function authorized(request: NextRequest) {
  const key = request.headers.get('x-registry-admin-key');
  return Boolean(process.env.REGISTRY_ADMIN_KEY && key && key === process.env.REGISTRY_ADMIN_KEY);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  await ensureRegistrySchema();
  const db = getDb();
  const requests = await db.select().from(subdomainRequests).orderBy(desc(subdomainRequests.createdAt)).limit(100);
  return NextResponse.json({ requests });
}

export async function PATCH(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await request.json() as { id?: string; action?: 'provision' | 'reject'; note?: string };
  if (!body.id || !body.action) return NextResponse.json({ error: 'Missing request action.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const record = await db.query.subdomainRequests.findFirst({ where: eq(subdomainRequests.id, body.id) });
  if (!record) return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
  if (record.status !== 'pending') return NextResponse.json({ error: 'Only pending requests can be reviewed.' }, { status: 409 });

  const note = body.note?.trim().slice(0, 500) || null;
  if (body.action === 'reject') {
    await db.update(subdomainRequests).set({ status: 'rejected', reviewerNote: note, reviewedAt: Date.now() }).where(eq(subdomainRequests.id, record.id));
    return NextResponse.json({ ok: true, status: 'rejected' });
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ZONE_ID) return NextResponse.json({ error: 'DNS provisioning is not configured yet.' }, { status: 503 });

  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'CNAME', name: `${record.subdomain}.${BASE_DOMAIN}`, content: record.cnameTarget, ttl: 1, proxied: false, comment: `Takeshi Domains request ${record.id}` }),
  });
  const payload = await response.json() as { success?: boolean; errors?: Array<{ message?: string }>; result?: { id?: string } };
  if (!response.ok || !payload.success || !payload.result?.id) return NextResponse.json({ error: payload.errors?.[0]?.message ?? 'Cloudflare DNS rejected this record.' }, { status: 502 });

  await db.update(subdomainRequests).set({ status: 'active', reviewerNote: note, reviewedAt: Date.now(), cloudflareRecordId: payload.result.id }).where(eq(subdomainRequests.id, record.id));
  return NextResponse.json({ ok: true, status: 'active', recordId: payload.result.id });
}
