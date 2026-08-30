import { and, count, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { dnsRecords, owners, subdomainRequests, subdomains } from '@/db/schema';
import { deleteCloudflareRecord } from '@/lib/cloudflare';
import { getOwnerSession } from '@/lib/owner-auth';
import { BASE_DOMAIN } from '@/lib/registry';

export async function DELETE(request: NextRequest) {
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { subdomainId?: string; confirmation?: string };
  try { body = await request.json() as { subdomainId?: string; confirmation?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (!body.subdomainId) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });

  const db = getDb();
  const domain = await db.query.subdomains.findFirst({
    where: and(eq(subdomains.id, body.subdomainId), eq(subdomains.ownerId, session.owner.id), eq(subdomains.status, 'active')),
  });
  if (!domain) return NextResponse.json({ error: 'Subdomain not found.' }, { status: 404 });

  const hostname = `${domain.label}.${BASE_DOMAIN}`;
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Type ${hostname} exactly to confirm deletion.` }, { status: 400 });

  const records = await db.select({ cloudflareRecordId: dnsRecords.cloudflareRecordId }).from(dnsRecords).where(eq(dnsRecords.subdomainId, domain.id));
  try {
    for (const record of records) await deleteCloudflareRecord(record.cloudflareRecordId);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare could not remove every DNS record.' }, { status: 502 });
  }

  await db.delete(subdomains).where(eq(subdomains.id, domain.id));
  if (domain.requestId) await db.delete(subdomainRequests).where(eq(subdomainRequests.id, domain.requestId));
  const [{ value: remainingDomains }] = await db.select({ value: count() }).from(subdomains).where(eq(subdomains.ownerId, session.owner.id));
  const ownerDeleted = remainingDomains === 0;
  if (ownerDeleted) await db.delete(owners).where(eq(owners.id, session.owner.id));

  return NextResponse.json({ ok: true, hostname, ownerDeleted });
}
