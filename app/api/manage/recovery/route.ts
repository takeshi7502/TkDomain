import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { dnsEvents, owners, ownerSessions, subdomainRequests, subdomains } from '@/db/schema';
import {
  clearPendingRequestSessionCookie,
  createOwnerSessionRecord,
  hashOwnerAccessKey,
  setOwnerSessionCookie,
} from '@/lib/owner-auth';
import { isValidOwnerAccessKey, isValidTelegramUsername, normalizeTelegramUsername } from '@/lib/registry';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  consumeTelegramVerificationCode,
  findTelegramLinkedOwner,
  sendTelegramVerificationCode,
} from '@/lib/telegram';

export const runtime = 'nodejs';

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

function recoveryMessage(username: string) {
  return `Nếu @${username} đã liên kết với một DNS Panel, bot đã gửi mã khôi phục. Kiểm tra tin nhắn Telegram rồi nhập mã bên dưới.`;
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function keyIsAvailable(ownerId: string, keyHash: string) {
  const db = getDb();
  const [ownerUsingKey] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.accessKeyHash, keyHash))
    .limit(1);
  if (ownerUsingKey && ownerUsingKey.id !== ownerId) return false;

  const [requestUsingKey] = await db
    .select({ id: subdomainRequests.id })
    .from(subdomainRequests)
    .where(and(
      eq(subdomainRequests.requestedAccessKeyHash, keyHash),
      inArray(subdomainRequests.status, ['pending', 'active', 'rejected']),
    ))
    .limit(1);
  return !requestUsingKey;
}

export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const ipLimit = await enforceRegistryRateLimit(request, 'owner-access-key-recovery', 6, 15 * 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã thử khôi phục quá nhiều lần. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) } },
    );
  }

  let body: { action?: unknown; telegramUsername?: unknown; code?: unknown; newAccessKey?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const username = normalizeTelegramUsername(typeof body.telegramUsername === 'string' ? body.telegramUsername : '');
  if (!isValidTelegramUsername(username)) {
    return NextResponse.json({ error: 'Nhập đúng Telegram username đã liên kết, không cần dấu @.' }, { status: 400 });
  }

  const linkedOwner = await findTelegramLinkedOwner(username);

  if (body.action === 'request-code') {
    // Keep this response identical whether or not the username is linked, so
    // the endpoint cannot be used to enumerate DNS Panel owners.
    if (!linkedOwner) return NextResponse.json({ ok: true, message: recoveryMessage(username) });

    const ownerLimit = await enforceRegistryScopedRateLimit('owner-access-key-recovery-send', linkedOwner.ownerId, 3, 15 * 60_000);
    if (!ownerLimit.allowed) {
      return NextResponse.json({ ok: true, message: recoveryMessage(username) });
    }

    const delivery = await sendTelegramVerificationCode({
      ownerId: linkedOwner.ownerId,
      purpose: 'access_key_recovery',
    });
    // Do not reveal whether a particular username has a linked delivery chat.
    // If delivery is unavailable the UI still offers the Admin fallback.
    if (delivery.status !== 'sent') return NextResponse.json({ ok: true, message: recoveryMessage(username) });
    return NextResponse.json({ ok: true, message: recoveryMessage(username) });
  }

  if (body.action !== 'reset-access-key') return NextResponse.json({ error: 'Unsupported recovery action.' }, { status: 400 });

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const newAccessKey = typeof body.newAccessKey === 'string' ? body.newAccessKey.trim() : '';
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: 'Mã Telegram phải gồm 6 chữ số.' }, { status: 400 });
  if (!isValidOwnerAccessKey(newAccessKey)) {
    return NextResponse.json({ error: 'Access key mới chưa đúng định dạng.' }, { status: 400 });
  }
  if (!linkedOwner) return NextResponse.json({ error: 'Mã khôi phục không hợp lệ hoặc đã hết hạn.' }, { status: 401 });

  const ownerLimit = await enforceRegistryScopedRateLimit('owner-access-key-recovery-verify', linkedOwner.ownerId, 8, 15 * 60_000);
  if (!ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã thử mã quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.' },
      { status: 429, headers: { 'Retry-After': String(ownerLimit.retryAfterSeconds) } },
    );
  }

  await ensureRegistrySchema();
  const db = getDb();
  const newAccessKeyHash = hashOwnerAccessKey(newAccessKey);
  const [currentOwner] = await db
    .select({ id: owners.id, accessKeyHash: owners.accessKeyHash })
    .from(owners)
    .where(and(eq(owners.id, linkedOwner.ownerId), eq(owners.status, 'active')))
    .limit(1);
  if (!currentOwner) return NextResponse.json({ error: 'Mã khôi phục không hợp lệ hoặc đã hết hạn.' }, { status: 401 });
  if (currentOwner.accessKeyHash === newAccessKeyHash) {
    return NextResponse.json({ error: 'Access key mới phải khác access key cũ.' }, { status: 400 });
  }
  if (!await keyIsAvailable(currentOwner.id, newAccessKeyHash)) {
    return NextResponse.json({ error: 'Access key này đang được dùng. Hãy chọn key khác.' }, { status: 409 });
  }

  const verification = await consumeTelegramVerificationCode({
    ownerId: currentOwner.id,
    purpose: 'access_key_recovery',
    code,
  });
  if (!verification.verified) {
    const suffix = verification.attemptsRemaining > 0
      ? ` Bạn còn ${verification.attemptsRemaining} lần thử.`
      : ' Hãy yêu cầu mã mới.';
    return NextResponse.json({ error: `Mã khôi phục không đúng hoặc đã hết hạn.${suffix}` }, { status: 401 });
  }

  const session = createOwnerSessionRecord(currentOwner.id);
  const now = Date.now();
  try {
    const changed = await db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: owners.id, accessKeyHash: owners.accessKeyHash })
        .from(owners)
        .where(and(eq(owners.id, currentOwner.id), eq(owners.status, 'active')))
        .for('update');
      if (!owner || owner.accessKeyHash === newAccessKeyHash) return false;

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
      if (updated.length === 0) return false;

      const [domain] = await tx
        .select({ id: subdomains.id, label: subdomains.label })
        .from(subdomains)
        .where(and(eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active')))
        .limit(1);

      await tx.delete(ownerSessions).where(eq(ownerSessions.ownerId, owner.id));
      await tx.insert(ownerSessions).values(session.record);
      await tx.insert(dnsEvents).values({
        id: crypto.randomUUID(),
        subdomainId: domain?.id ?? null,
        domainLabel: domain?.label ?? null,
        actorType: 'owner',
        action: 'owner_access_key_recovered',
        details: { via: 'telegram', invalidatedSessions: true },
        createdAt: now,
      });
      return true;
    });

    if (!changed) {
      return NextResponse.json({ error: 'Không thể đổi access key này. Hãy yêu cầu mã mới rồi thử lại.' }, { status: 409 });
    }
  } catch (error) {
    if (isUniqueViolation(error) || error instanceof Error && error.message === 'new-key-unavailable') {
      return NextResponse.json({ error: 'Access key này vừa được dùng. Hãy yêu cầu mã mới và chọn key khác.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Không thể khôi phục access key lúc này. Hãy yêu cầu mã mới rồi thử lại.' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true });
  clearPendingRequestSessionCookie(response);
  setOwnerSessionCookie(response, session.token);
  return response;
}
