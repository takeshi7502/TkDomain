import { NextRequest, NextResponse } from 'next/server';

import { isAdminAuthorized } from '@/lib/admin-auth';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';
import { sendAdminTelegramTest } from '@/lib/telegram';

export async function POST(request: NextRequest) {
  if (!isAdminAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const limit = await enforceRegistryRateLimit(request, 'admin-telegram-test', 5, 15 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã gửi quá nhiều test. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
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
