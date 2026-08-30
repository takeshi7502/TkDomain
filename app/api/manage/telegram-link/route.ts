import { NextRequest, NextResponse } from 'next/server';

import { getOwnerSession } from '@/lib/owner-auth';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  createTelegramBotDeepLink,
  createTelegramLinkToken,
  getTelegramLinkForOwner,
  sendTelegramVerificationCode,
  unlinkTelegramForOwner,
} from '@/lib/telegram';

export const runtime = 'nodejs';

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

/**
 * Create a short-lived, single-use Telegram /start link for the signed-in
 * owner. The raw token only ever exists in the returned t.me URL; the database
 * stores an HMAC of it instead.
 */
export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const [ipLimit, ownerLimit] = await Promise.all([
    enforceRegistryRateLimit(request, 'telegram-link-create', 6, 15 * 60_000),
    enforceRegistryScopedRateLimit('telegram-link-create', session.owner.id, 6, 15 * 60_000),
  ]);
  if (!ipLimit.allowed || !ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã tạo quá nhiều link liên kết. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
    );
  }

  const existing = await getTelegramLinkForOwner(session.owner.id);
  if (existing) {
    return NextResponse.json({ error: 'DNS Panel này đã liên kết Telegram. Liên hệ Admin nếu cần đổi tài khoản Telegram.' }, { status: 409 });
  }

  const token = await createTelegramLinkToken(session.owner.id);
  if (token.status !== 'created') return NextResponse.json({ error: 'DNS Panel không còn hoạt động.' }, { status: 409 });

  const url = await createTelegramBotDeepLink(token.token);
  if (!url) {
    return NextResponse.json({ error: 'Bot Telegram chưa sẵn sàng. Hãy báo Admin kiểm tra cấu hình bot.' }, { status: 503 });
  }

  return NextResponse.json({ ok: true, url, expiresAt: token.expiresAt });
}

/** Send an out-of-band code before an authenticated owner can remove a link. */
export async function PATCH(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const [ipLimit, ownerLimit] = await Promise.all([
    enforceRegistryRateLimit(request, 'telegram-unlink-code', 4, 15 * 60_000),
    enforceRegistryScopedRateLimit('telegram-unlink-code', session.owner.id, 3, 15 * 60_000),
  ]);
  if (!ipLimit.allowed || !ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã yêu cầu quá nhiều mã xác nhận. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
    );
  }

  const delivery = await sendTelegramVerificationCode({
    ownerId: session.owner.id,
    purpose: 'telegram_unlink',
  });
  if (delivery.status === 'not-linked') {
    return NextResponse.json({ error: 'DNS Panel này chưa liên kết Telegram.' }, { status: 409 });
  }
  if (delivery.status === 'bot-not-configured') {
    return NextResponse.json({ error: 'Bot Telegram chưa sẵn sàng. Hãy báo Admin kiểm tra cấu hình bot.' }, { status: 503 });
  }
  if (delivery.status === 'delivery-failed') {
    return NextResponse.json({ error: 'Không gửi được mã Telegram lúc này. Hãy thử lại sau.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, expiresAt: delivery.expiresAt });
}

/** Confirm the code and atomically revoke the verified Telegram link. */
export async function DELETE(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const [ipLimit, ownerLimit] = await Promise.all([
    enforceRegistryRateLimit(request, 'telegram-unlink-verify', 8, 15 * 60_000),
    enforceRegistryScopedRateLimit('telegram-unlink-verify', session.owner.id, 8, 15 * 60_000),
  ]);
  if (!ipLimit.allowed || !ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã thử mã quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
    );
  }

  let body: { code?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: 'Mã Telegram phải gồm 6 chữ số.' }, { status: 400 });

  const result = await unlinkTelegramForOwner({ ownerId: session.owner.id, code });
  if (result.status === 'unlinked') return NextResponse.json({ ok: true });
  if (result.status === 'not-linked') return NextResponse.json({ error: 'Telegram này đã được hủy liên kết.' }, { status: 409 });

  const suffix = result.attemptsRemaining > 0
    ? ` Bạn còn ${result.attemptsRemaining} lần thử.`
    : ' Hãy yêu cầu mã mới.';
  return NextResponse.json({ error: `Mã Telegram không đúng hoặc đã hết hạn.${suffix}` }, { status: 401 });
}
