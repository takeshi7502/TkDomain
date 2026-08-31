import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import {
  dnsEvents,
  managedDomains,
  owners,
  ownerSessions,
  subdomainRequests,
  subdomains,
  telegramLinks,
  telegramRecoveryGrants,
} from '@/db/schema';
import {
  clearPendingRequestSessionCookie,
  createOwnerSessionRecord,
  hashOwnerAccessKey,
  setOwnerSessionCookie,
} from '@/lib/owner-auth';
import { BASE_DOMAIN, isValidOwnerAccessKey } from '@/lib/registry';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  findTelegramLinkedOwner,
  hashTelegramRecoveryGrant,
  isValidTelegramRecoveryIdentifier,
  sendTelegramVerificationCode,
  verifyTelegramRecoveryCode,
} from '@/lib/telegram';

export const runtime = 'nodejs';

type RecoveryBody = {
  action?: unknown;
  identifier?: unknown;
  code?: unknown;
  grant?: unknown;
  newAccessKey?: unknown;
};

type ResetResult = 'changed' | 'invalid-grant' | 'same-key';

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

function notLinkedMessage() {
  return 'Không tìm thấy DNS Panel đã liên kết với Telegram này. Nếu bạn chưa liên kết bot, hãy liên hệ Admin.';
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function rateLimitResponse(retryAfterSeconds: number, message: string) {
  return NextResponse.json({ error: message }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } });
}

async function enforceRecoveryIpLimit(request: NextRequest, action: string, limit: number) {
  return enforceRegistryRateLimit(request, `owner-access-key-recovery-${action}`, limit, 15 * 60_000);
}

export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  let body: RecoveryBody;
  try {
    body = await request.json() as RecoveryBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (action !== 'lookup' && action !== 'send-code' && action !== 'verify-code' && action !== 'reset-access-key') {
    return NextResponse.json({ error: 'Unsupported recovery action.' }, { status: 400 });
  }

  const ipLimit = await enforceRecoveryIpLimit(
    request,
    action,
    action === 'lookup' ? 12 : action === 'send-code' ? 6 : 8,
  );
  if (!ipLimit.allowed) {
    return rateLimitResponse(ipLimit.retryAfterSeconds, 'Bạn đã thử khôi phục quá nhiều lần. Hãy chờ ít phút rồi thử lại.');
  }

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  if (!isValidTelegramRecoveryIdentifier(identifier)) {
    return NextResponse.json({ error: 'Nhập Telegram username (@username) hoặc Telegram ID số đã liên kết.' }, { status: 400 });
  }

  // This query only sees records created by the verified bot webhook. The
  // unverified username from the original registration is never queried here.
  const linkedOwner = await findTelegramLinkedOwner(identifier);

  if (action === 'lookup') {
    if (!linkedOwner) {
      return NextResponse.json({ ok: true, linked: false, message: notLinkedMessage() });
    }
    return NextResponse.json({
      ok: true,
      linked: true,
      message: 'Đã tìm thấy Telegram đã liên kết. Bạn có thể yêu cầu mã khôi phục.',
    });
  }

  if (!linkedOwner) return NextResponse.json({ error: notLinkedMessage() }, { status: 404 });

  if (action === 'send-code') {
    const ownerLimit = await enforceRegistryScopedRateLimit('owner-access-key-recovery-send', linkedOwner.ownerId, 3, 15 * 60_000);
    if (!ownerLimit.allowed) {
      return rateLimitResponse(ownerLimit.retryAfterSeconds, 'Bạn đã yêu cầu quá nhiều mã khôi phục. Hãy chờ ít phút rồi thử lại.');
    }

    const delivery = await sendTelegramVerificationCode({
      ownerId: linkedOwner.ownerId,
      purpose: 'access_key_recovery',
    });
    if (delivery.status === 'not-linked') return NextResponse.json({ error: notLinkedMessage() }, { status: 404 });
    if (delivery.status === 'bot-not-configured') {
      return NextResponse.json({ error: 'Bot Telegram chưa sẵn sàng. Hãy báo Admin kiểm tra cấu hình bot.' }, { status: 503 });
    }
    if (delivery.status === 'delivery-failed') {
      return NextResponse.json({ error: 'Không gửi được mã Telegram lúc này. Hãy thử lại sau.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, sent: true, expiresAt: delivery.expiresAt });
  }

  if (action === 'verify-code') {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: 'Mã Telegram phải gồm 6 chữ số.' }, { status: 400 });

    const ownerLimit = await enforceRegistryScopedRateLimit('owner-access-key-recovery-verify', linkedOwner.ownerId, 8, 15 * 60_000);
    if (!ownerLimit.allowed) {
      return rateLimitResponse(ownerLimit.retryAfterSeconds, 'Bạn đã thử mã quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.');
    }

    const verification = await verifyTelegramRecoveryCode({ ownerId: linkedOwner.ownerId, code });
    if (!verification.verified) {
      const suffix = verification.attemptsRemaining > 0
        ? ` Bạn còn ${verification.attemptsRemaining} lần thử.`
        : ' Hãy yêu cầu mã mới.';
      return NextResponse.json({ error: `Mã khôi phục không đúng hoặc đã hết hạn.${suffix}` }, { status: 401 });
    }
    return NextResponse.json({ ok: true, grant: verification.grant, expiresAt: verification.expiresAt });
  }

  const newAccessKey = typeof body.newAccessKey === 'string' ? body.newAccessKey.trim() : '';
  if (!isValidOwnerAccessKey(newAccessKey)) {
    return NextResponse.json({ error: 'Access key mới chưa đúng định dạng.' }, { status: 400 });
  }
  const grantHash = hashTelegramRecoveryGrant(linkedOwner.ownerId, body.grant);
  if (!grantHash) return NextResponse.json({ error: 'Phiên khôi phục không hợp lệ hoặc đã hết hạn. Hãy lấy mã mới.' }, { status: 401 });

  const ownerLimit = await enforceRegistryScopedRateLimit('owner-access-key-recovery-reset', linkedOwner.ownerId, 6, 15 * 60_000);
  if (!ownerLimit.allowed) {
    return rateLimitResponse(ownerLimit.retryAfterSeconds, 'Bạn đã thử đặt access key quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.');
  }

  await ensureRegistrySchema();
  const db = getDb();
  const newAccessKeyHash = hashOwnerAccessKey(newAccessKey);
  const session = createOwnerSessionRecord(linkedOwner.ownerId);
  const now = Date.now();

  try {
    const result = await db.transaction(async (tx): Promise<ResetResult> => {
      const [owner] = await tx
        .select({ id: owners.id, accessKeyHash: owners.accessKeyHash })
        .from(owners)
        .where(and(eq(owners.id, linkedOwner.ownerId), eq(owners.status, 'active')))
        .limit(1)
        .for('update');
      if (!owner) return 'invalid-grant';

      // Keep the same lock order as unlinking: owner -> verified link -> grant.
      const [link] = await tx
        .select({ id: telegramLinks.id })
        .from(telegramLinks)
        .where(eq(telegramLinks.ownerId, owner.id))
        .limit(1)
        .for('update');
      if (!link) return 'invalid-grant';

      const [grant] = await tx
        .select({ id: telegramRecoveryGrants.id })
        .from(telegramRecoveryGrants)
        .where(and(
          eq(telegramRecoveryGrants.ownerId, owner.id),
          eq(telegramRecoveryGrants.telegramLinkId, link.id),
          eq(telegramRecoveryGrants.tokenHash, grantHash),
          isNull(telegramRecoveryGrants.consumedAt),
          gt(telegramRecoveryGrants.expiresAt, now),
        ))
        .limit(1)
        .for('update');
      if (!grant) return 'invalid-grant';
      if (owner.accessKeyHash === newAccessKeyHash) return 'same-key';

      const [ownerUsingKey] = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(eq(owners.accessKeyHash, newAccessKeyHash))
        .limit(1);
      if (ownerUsingKey && ownerUsingKey.id !== owner.id) throw new Error('new-key-unavailable');

      const [requestUsingKey] = await tx
        .select({ id: subdomainRequests.id })
        .from(subdomainRequests)
        .where(and(
          eq(subdomainRequests.requestedAccessKeyHash, newAccessKeyHash),
          inArray(subdomainRequests.status, ['pending', 'active', 'rejected']),
        ))
        .limit(1);
      if (requestUsingKey) throw new Error('new-key-unavailable');

      const updated = await tx.update(owners)
        .set({ accessKeyHash: newAccessKeyHash, updatedAt: now })
        .where(and(eq(owners.id, owner.id), eq(owners.status, 'active')))
        .returning({ id: owners.id });
      if (updated.length === 0) return 'invalid-grant';

      const [domain] = await tx
        .select({ id: subdomains.id, label: subdomains.label, parentDomain: managedDomains.hostname })
        .from(subdomains)
        .innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id))
        .where(and(eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active')))
        .limit(1);

      await tx.update(telegramRecoveryGrants)
        .set({ consumedAt: now })
        .where(eq(telegramRecoveryGrants.id, grant.id));
      await tx.delete(ownerSessions).where(eq(ownerSessions.ownerId, owner.id));
      await tx.insert(ownerSessions).values(session.record);
      await tx.insert(dnsEvents).values({
        id: crypto.randomUUID(),
        subdomainId: domain?.id ?? null,
        domainLabel: domain?.label ?? null,
        parentDomain: domain?.parentDomain ?? BASE_DOMAIN,
        actorType: 'owner',
        action: 'owner_access_key_recovered',
        details: { via: 'verified_telegram', invalidatedSessions: true },
        createdAt: now,
      });
      return 'changed';
    });

    if (result === 'invalid-grant') {
      return NextResponse.json({ error: 'Phiên khôi phục không hợp lệ hoặc đã hết hạn. Hãy lấy mã mới.' }, { status: 401 });
    }
    if (result === 'same-key') {
      return NextResponse.json({ error: 'Access key mới phải khác access key cũ.' }, { status: 400 });
    }
  } catch (error) {
    if (isUniqueViolation(error) || error instanceof Error && error.message === 'new-key-unavailable') {
      return NextResponse.json({ error: 'Access key này vừa được dùng. Hãy chọn key khác.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Không thể khôi phục access key lúc này. Hãy yêu cầu mã mới rồi thử lại.' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true });
  clearPendingRequestSessionCookie(response);
  setOwnerSessionCookie(response, session.token);
  return response;
}
