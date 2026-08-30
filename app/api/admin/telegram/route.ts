import { NextRequest, NextResponse } from 'next/server';

import { isAdminAuthorized } from '@/lib/admin-auth';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';
import { configureTelegramWebhook, sendAdminTelegramTest } from '@/lib/telegram';

export async function POST(request: NextRequest) {
  if (!isAdminAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { action?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* Existing test callers may send no JSON body. */ }
  const action = body.action === 'configure-webhook' ? 'configure-webhook' : 'test';

  const limit = await enforceRegistryRateLimit(request, `admin-telegram-${action}`, 5, 15 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã gửi quá nhiều test. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  if (action === 'configure-webhook') {
    // Keep production as the canonical delivery endpoint even if the browser
    // happens to be using an automatically generated Vercel deployment URL.
    const publicUrl = process.env.REGISTRY_PUBLIC_URL?.trim() || 'https://domain.takeshi.dev';
    const result = await configureTelegramWebhook(`${publicUrl.replace(/\/+$/, '')}/api/telegram/webhook`);
    if (!result.configured) {
      return NextResponse.json({ error: 'Cần TELEGRAM_BOT_TOKEN và TELEGRAM_WEBHOOK_SECRET hợp lệ trên Vercel trước.' }, { status: 400 });
    }
    if (!result.updated) {
      return NextResponse.json({ error: 'Không cài được webhook Telegram. Kiểm tra URL production, token và secret rồi thử lại.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, message: 'Webhook bot đã được cài cho domain.takeshi.dev.' });
  }

  const result = await sendAdminTelegramTest();
  if (!result.configured) {
    return NextResponse.json({ error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_ADMIN_CHAT_ID trên Vercel.' }, { status: 400 });
  }
  if (!result.sent) {
    return NextResponse.json({ error: 'Không gửi được Telegram. Kiểm tra token, chat ID và đảm bảo bot có quyền nhắn vào chat đích.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
