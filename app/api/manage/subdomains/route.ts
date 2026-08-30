import { and, count, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { dnsEvents, dnsRecords, owners, subdomainRequests, subdomains } from '@/db/schema';
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

  const records = await db.select({
    id: dnsRecords.id,
    cloudflareRecordId: dnsRecords.cloudflareRecordId,
    recordType: dnsRecords.recordType,
    recordName: dnsRecords.recordName,
    ttl: dnsRecords.ttl,
    proxied: dnsRecords.proxied,
    priority: dnsRecords.priority,
    isPrimary: dnsRecords.isPrimary,
  }).from(dnsRecords).where(eq(dnsRecords.subdomainId, domain.id));
  try {
    for (const record of records) await deleteCloudflareRecord(record.cloudflareRecordId);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cloudflare could not remove every DNS record.' }, { status: 502 });
  }

  const now = Date.now();
  let ownerDeleted: boolean;
  try {
    ownerDeleted = await db.transaction(async (tx) => {
      await tx.insert(dnsEvents).values([
        ...records.map((record) => ({
          id: crypto.randomUUID(),
          subdomainId: domain.id,
          domainLabel: domain.label,
          recordId: record.id,
          actorType: 'owner' as const,
          action: record.isPrimary ? 'primary_record_deleted' : 'child_record_deleted',
          details: {
            type: record.recordType,
            name: record.recordName,
            ttl: record.ttl,
            proxied: record.proxied,
            priority: record.priority,
            isPrimary: record.isPrimary,
            source: 'subdomain_release',
          },
          createdAt: now,
        })),
        {
          id: crypto.randomUUID(),
          subdomainId: domain.id,
          domainLabel: domain.label,
          actorType: 'owner',
          action: 'subdomain_released',
          details: { hostname, deletedRecordCount: records.length },
          createdAt: now,
        },
      ]);
      if (domain.requestId) {
        const released = await tx.update(subdomainRequests)
          .set({ status: 'released', releasedAt: now })
          .where(and(eq(subdomainRequests.id, domain.requestId), eq(subdomainRequests.status, 'active')))
          .returning({ id: subdomainRequests.id });
        if (released.length === 0) throw new Error('Request status changed before the subdomain was released.');
      }
      const deleted = await tx.delete(subdomains)
        .where(and(eq(subdomains.id, domain.id), eq(subdomains.ownerId, session.owner.id), eq(subdomains.status, 'active')))
        .returning({ id: subdomains.id });
      if (deleted.length === 0) throw new Error('Subdomain status changed before deletion.');
      const [{ value: remainingDomains }] = await tx.select({ value: count() }).from(subdomains).where(eq(subdomains.ownerId, session.owner.id));
      if (remainingDomains === 0) await tx.delete(owners).where(eq(owners.id, session.owner.id));
      return remainingDomains === 0;
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Không thể lưu trạng thái xóa subdomain.' }, { status: 409 });
  }

  return NextResponse.json({ ok: true, hostname, ownerDeleted });
}
