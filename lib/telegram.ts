type TelegramSendResult = {
  configured: boolean;
  sent: boolean;
};

type NewRequestNotification = {
  requestId: string;
  subdomain: string;
  cnameTarget: string;
  telegramUsername: string;
};

const REGISTRY_ADMIN_URL = 'https://domain.takeshi.dev/admin';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

function adminBotConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

function singleLine(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

async function sendAdminTelegramMessage(text: string): Promise<TelegramSendResult> {
  const config = adminBotConfig();
  if (!config) return { configured: false, sent: false };

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(7_000),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !payload?.ok) {
      console.warn('Telegram admin notification failed.', { status: response.status, description: payload?.description ?? 'Unknown Telegram API error.' });
      return { configured: true, sent: false };
    }
    return { configured: true, sent: true };
  } catch (error) {
    console.warn('Telegram admin notification failed.', { message: error instanceof Error ? error.message : 'Unknown delivery error.' });
    return { configured: true, sent: false };
  }
}

export async function notifyAdminOfNewRequest(request: NewRequestNotification) {
  return sendAdminTelegramMessage([
    '🟡 TAKESHI DOMAINS · REQUEST MỚI',
    '',
    `Tên: ${singleLine(request.subdomain)}.takeshi.dev`,
    `CNAME: ${singleLine(request.cnameTarget)}`,
    `Telegram: @${singleLine(request.telegramUsername)}`,
    `Mã request: ${request.requestId.slice(0, 8)}`,
    '',
    `Mở admin: ${REGISTRY_ADMIN_URL}`,
  ].join('\n'));
}

export async function sendAdminTelegramTest() {
  return sendAdminTelegramMessage([
    '✅ TAKESHI DOMAINS · BOT ĐÃ KẾT NỐI',
    '',
    'Thông báo request mới sẽ được gửi vào chat này.',
    `Admin: ${REGISTRY_ADMIN_URL}`,
  ].join('\n'));
}
