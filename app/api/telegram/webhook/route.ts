import { NextRequest, NextResponse } from 'next/server';

import {
  consumeTelegramLinkToken,
  hasProcessedTelegramWebhookUpdate,
  isTelegramWebhookSecretValid,
  markTelegramWebhookUpdateProcessed,
  sendTelegramMessage,
  type TelegramIdentity,
} from '@/lib/telegram';
import { isValidTelegramUsername, normalizeTelegramUsername } from '@/lib/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safePrivateTelegramId(value: unknown) {
  // Telegram currently sends numeric IDs. Reject unsafe numbers instead of
  // silently rounding a future 64-bit identity into a different account.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value;
  return null;
}

function safeDisplayName(from: JsonRecord) {
  const parts = [from.first_name, from.last_name]
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter(Boolean);
  const displayName = parts.join(' ').trim();
  return displayName ? displayName.slice(0, 160) : null;
}

function linkedUsername(value: unknown) {
  if (typeof value !== 'string') return null;
  const username = normalizeTelegramUsername(value);
  return isValidTelegramUsername(username) ? username : null;
}

function parseStartToken(text: string) {
  const match = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text.trim());
  if (!match) return undefined;
  return match[1] ?? null;
}

function safeUpdateId(payload: unknown) {
  if (!isRecord(payload)) return null;
  const updateId = payload.update_id;
  if (typeof updateId === 'number' && Number.isSafeInteger(updateId) && updateId >= 0) return String(updateId);
  if (typeof updateId === 'string' && /^\d{1,20}$/.test(updateId)) return updateId;
  return null;
}

function parseDirectStartUpdate(payload: unknown): { token: string | null; identity: TelegramIdentity } | null {
  if (!isRecord(payload) || !isRecord(payload.message)) return null;
  const message = payload.message;
  if (typeof message.text !== 'string' || !isRecord(message.chat) || !isRecord(message.from)) return null;
  const chat = message.chat;
  const from = message.from;
  if (chat.type !== 'private' || from.is_bot === true) return null;

  const chatId = safePrivateTelegramId(chat.id);
  const telegramUserId = safePrivateTelegramId(from.id);
  // In a direct user chat the two IDs must be identical. This rules out group
  // messages and forwarded/forged-looking payloads from ever becoming a
  // recovery delivery target.
  if (!chatId || !telegramUserId || chatId !== telegramUserId) return null;

  const token = parseStartToken(message.text);
  if (token === undefined) return null;
  return {
    token,
    identity: {
      telegramUserId,
      chatId,
      linkedUsername: linkedUsername(from.username),
      displayName: safeDisplayName(from),
    },
  };
}

function linkReply(status: Awaited<ReturnType<typeof consumeTelegramLinkToken>>['status']) {
  switch (status) {
    case 'linked':
    case 'already-linked-to-owner':
      return '✅ Đã liên kết Telegram với DNS Panel. Bạn có thể quay lại domain.takeshi.dev.';
    case 'linked-to-another-owner':
      return '⚠️ Tài khoản Telegram này đã được liên kết với một DNS Panel khác.';
    case 'owner-already-linked':
      return '⚠️ DNS Panel này đã liên kết với một Telegram khác. Liên hệ Admin nếu cần đổi tài khoản Telegram.';
    case 'invalid-or-expired':
      return '⚠️ Link liên kết không hợp lệ hoặc đã hết hạn. Hãy tạo link mới từ DNS Panel.';
  }
}

export async function POST(request: NextRequest) {
  if (!isTelegramWebhookSecretValid(request.headers.get('x-telegram-bot-api-secret-token'))) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    return new NextResponse('Payload too large', { status: 413 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new NextResponse('Invalid update', { status: 400 });
  }

  const update = parseDirectStartUpdate(payload);
  // Deliberately acknowledge unsupported updates. Telegram will otherwise
  // retry messages from groups or normal chat text indefinitely.
  if (!update || !update.token) return NextResponse.json({ ok: true });

  const updateId = safeUpdateId(payload);
  if (updateId && await hasProcessedTelegramWebhookUpdate(updateId)) return NextResponse.json({ ok: true });

  try {
    const result = await consumeTelegramLinkToken(update.token, update.identity);
    await sendTelegramMessage(update.identity.chatId, linkReply(result.status));
    if (updateId) await markTelegramWebhookUpdateProcessed(updateId);
  } catch {
    // Do not include errors, the request body, token, or chat identifiers in
    // logs. A 500 makes Telegram retry a transient database failure safely.
    console.error('Telegram webhook processing failed.');
    return new NextResponse('Webhook processing failed', { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
