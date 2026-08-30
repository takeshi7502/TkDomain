import { NextRequest, NextResponse } from 'next/server';

import { getOwnerSession } from '@/lib/owner-auth';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  createTelegramBotDeepLink,
  createTelegramLinkToken,
  getTelegramLinkForOwner,
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
