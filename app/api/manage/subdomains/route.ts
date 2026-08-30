import { and, count, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { dnsEvents, dnsRecords, owners, subdomainRequests, subdomains } from '@/db/schema';
import { deleteCloudflareRecord } from '@/lib/cloudflare';
import { getOwnerSession } from '@/lib/owner-auth';
import { BASE_DOMAIN } from '@/lib/registry';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  consumeTelegramVerificationCode,
  getTelegramLinkForOwner,
  sendTelegramVerificationCode,
} from '@/lib/telegram';

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

async function ownedActiveSubdomain(ownerId: string, subdomainId: string) {
  return getDb().query.subdomains.findFirst({
    where: and(eq(subdomains.id, subdomainId), eq(subdomains.ownerId, ownerId), eq(subdomains.status, 'active')),
  });
}

/** Request an out-of-band deletion code when the owner has linked Telegram. */
export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const [ipLimit, ownerLimit] = await Promise.all([
    enforceRegistryRateLimit(request, 'subdomain-delete-code', 4, 15 * 60_000),
    enforceRegistryScopedRateLimit('subdomain-delete-code', session.owner.id, 3, 15 * 60_000),
  ]);
  if (!ipLimit.allowed || !ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã yêu cầu quá nhiều mã xác minh. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
    );
  }

  let body: { subdomainId?: unknown; confirmation?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  const subdomainId = typeof body.subdomainId === 'string' ? body.subdomainId : '';
  if (!subdomainId) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });

  const domain = await ownedActiveSubdomain(session.owner.id, subdomainId);
  if (!domain) return NextResponse.json({ error: 'Subdomain not found.' }, { status: 404 });
  const hostname = `${domain.label}.${BASE_DOMAIN}`;
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Type ${hostname} exactly to confirm deletion.` }, { status: 400 });

  const delivery = await sendTelegramVerificationCode({
    ownerId: session.owner.id,
    purpose: 'subdomain_delete',
    subject: domain.id,
  });
  if (delivery.status === 'not-linked') return NextResponse.json({ ok: true, otpRequired: false });
  if (delivery.status === 'bot-not-configured') {
    return NextResponse.json({ error: 'Bot Telegram chưa được cấu hình. Liên hệ Admin để hoàn tất hoặc hỗ trợ xóa subdomain.' }, { status: 503 });
  }
  if (delivery.status === 'delivery-failed') {
    return NextResponse.json({ error: 'Không gửi được mã Telegram lúc này. Hãy thử lại sau.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, otpRequired: true, expiresAt: delivery.expiresAt });
}

export async function DELETE(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { subdomainId?: string; confirmation?: string; code?: string };
  try { body = await request.json() as { subdomainId?: string; confirmation?: string; code?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (!body.subdomainId) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });

  const db = getDb();
  const domain = await ownedActiveSubdomain(session.owner.id, body.subdomainId);
  if (!domain) return NextResponse.json({ error: 'Subdomain not found.' }, { status: 404 });

  const hostname = `${domain.label}.${BASE_DOMAIN}`;
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Type ${hostname} exactly to confirm deletion.` }, { status: 400 });

  const linkedTelegram = await getTelegramLinkForOwner(session.owner.id);
  if (linkedTelegram) {
    const [ipLimit, ownerLimit] = await Promise.all([
      enforceRegistryRateLimit(request, 'subdomain-delete-verify', 8, 15 * 60_000),
      enforceRegistryScopedRateLimit('subdomain-delete-verify', session.owner.id, 8, 15 * 60_000),
    ]);
    if (!ipLimit.allowed || !ownerLimit.allowed) {
      return NextResponse.json(
        { error: 'Bạn đã thử xác minh quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.' },
        { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
      );
    }

    const verification = await consumeTelegramVerificationCode({
      ownerId: session.owner.id,
      purpose: 'subdomain_delete',
      subject: domain.id,
      code: body.code ?? '',
    });
    if (!verification.verified) {
      const suffix = verification.attemptsRemaining > 0
        ? ` Bạn còn ${verification.attemptsRemaining} lần thử.`
        : ' Hãy yêu cầu mã mới.';
      return NextResponse.json({ error: `Mã Telegram không đúng hoặc đã hết hạn.${suffix}` }, { status: 401 });
    }
  }

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
