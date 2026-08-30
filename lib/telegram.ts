import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { ensureRegistrySchema, getDb } from '@/db';
import {
  dnsEvents,
  owners,
  subdomains,
  telegramLinkTokens,
  telegramLinks,
  telegramVerificationChallenges,
  telegramWebhookUpdates,
} from '@/db/schema';
import { isValidTelegramUsername, normalizeTelegramUsername } from '@/lib/registry';

const REGISTRY_ADMIN_URL = 'https://domain.takeshi.dev/admin';
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LINK_TOKEN_TTL_MS = 10 * 60 * 1_000;
const DELETE_VERIFICATION_CODE_TTL_MS = 5 * 60 * 1_000;
const RECOVERY_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1_000;
const MAX_CODE_ATTEMPTS = 5;

export const TELEGRAM_VERIFICATION_PURPOSES = ['subdomain_delete', 'access_key_recovery'] as const;
export type TelegramVerificationPurpose = (typeof TELEGRAM_VERIFICATION_PURPOSES)[number];

export type TelegramIdentity = {
  telegramUserId: string;
  chatId: string;
  linkedUsername: string | null;
  displayName: string | null;
};

export type TelegramLinkProfile = {
  telegramUserId: string;
  linkedUsername: string | null;
  displayName: string | null;
  linkedAt: number;
  updatedAt: number;
};

export type TelegramSendResult = {
  configured: boolean;
  sent: boolean;
};

type NewRequestNotification = {
  requestId: string;
  subdomain: string;
  cnameTarget: string;
  telegramUsername: string;
};

export type TelegramBotIdentity =
  | { configured: false; username: null; url: null }
  | { configured: true; username: string | null; url: string | null };

export type TelegramLinkTokenResult =
  | { status: 'created'; token: string; expiresAt: number }
  | { status: 'owner-not-found' };

export type TelegramLinkResult =
  | { status: 'linked'; profile: TelegramLinkProfile }
  | { status: 'already-linked-to-owner'; profile: TelegramLinkProfile }
  | { status: 'linked-to-another-owner' }
  | { status: 'owner-already-linked' }
  | { status: 'invalid-or-expired' };

export type TelegramVerificationChallengeResult =
  | { status: 'created'; code: string; expiresAt: number; chatId: string }
  | { status: 'not-linked' };

export type TelegramVerificationCheckResult =
  | { verified: true }
  | { verified: false; attemptsRemaining: number };

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function configuredBotUsername() {
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || '';
  return isValidTelegramUsername(username) ? username : null;
}

function adminBotConfig() {
  const token = botToken();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

function registrySecret() {
  const secret = process.env.REGISTRY_ADMIN_KEY;
  if (!secret) throw new Error('REGISTRY_ADMIN_KEY is unavailable.');
  return secret;
}

function hashTelegramSecret(namespace: string, value: string) {
  return createHmac('sha256', registrySecret()).update(`${namespace}\u0000${value}`).digest('hex');
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function singleLine(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function compactText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return compact ? compact.slice(0, maxLength) : null;
}

function challengeFilter(ownerId: string, purpose: TelegramVerificationPurpose, subject: string | null) {
  return subject === null
    ? and(
      eq(telegramVerificationChallenges.ownerId, ownerId),
      eq(telegramVerificationChallenges.purpose, purpose),
      isNull(telegramVerificationChallenges.subject),
    )
    : and(
      eq(telegramVerificationChallenges.ownerId, ownerId),
      eq(telegramVerificationChallenges.purpose, purpose),
      eq(telegramVerificationChallenges.subject, subject),
    );
}

function challengeCodeHash(ownerId: string, purpose: TelegramVerificationPurpose, subject: string | null, code: string) {
  return hashTelegramSecret('verification-code', `${ownerId}\u0000${purpose}\u0000${subject ?? ''}\u0000${code}`);
}

function verificationCodeTtlMs(purpose: TelegramVerificationPurpose) {
  return purpose === 'subdomain_delete'
    ? DELETE_VERIFICATION_CODE_TTL_MS
    : RECOVERY_VERIFICATION_CODE_TTL_MS;
}

function profileFromLink(link: typeof telegramLinks.$inferSelect): TelegramLinkProfile {
  return {
    telegramUserId: link.telegramUserId,
    linkedUsername: link.linkedUsername,
    displayName: link.displayName,
    linkedAt: link.linkedAt,
    updatedAt: link.updatedAt,
  };
}

async function telegramApiRequest(path: string, body?: Record<string, unknown>) {
  const token = botToken();
  if (!token) return { configured: false as const, response: null };

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(7_000),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: unknown } | null;
    if (!response.ok || !payload?.ok) {
      // Do not log the API response: it can include private chat information.
      console.warn('Telegram API request failed.', { method: path, status: response.status });
      return { configured: true as const, response: null };
    }
    return { configured: true as const, response: payload.result };
  } catch {
    console.warn('Telegram API request failed.', { method: path, status: 'network-error' });
    return { configured: true as const, response: null };
  }
}

/** Send a plain-text message without ever exposing a bot token in a response or log. */
export async function sendTelegramMessage(chatId: string, text: string): Promise<TelegramSendResult> {
  if (!chatId.trim() || !text.trim()) return { configured: Boolean(botToken()), sent: false };
  const result = await telegramApiRequest('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4_096),
    disable_web_page_preview: true,
  });
  return { configured: result.configured, sent: result.response !== null };
}

/**
 * Returns the bot identity needed to construct a deep link. A configured
 * TELEGRAM_BOT_USERNAME avoids a network call; otherwise it is fetched via
 * getMe when the user opens the linking flow.
 */
export async function getTelegramBotIdentity(): Promise<TelegramBotIdentity> {
  if (!botToken()) return { configured: false, username: null, url: null };

  const configuredUsername = configuredBotUsername();
  if (configuredUsername) {
    return { configured: true, username: configuredUsername, url: `https://t.me/${configuredUsername}` };
  }

  const result = await telegramApiRequest('getMe');
  if (!result.configured || !result.response || typeof result.response !== 'object') {
    return { configured: result.configured, username: null, url: null };
  }
  const username = compactText((result.response as { username?: unknown }).username, 64);
  if (!username || !isValidTelegramUsername(username)) return { configured: true, username: null, url: null };
  return { configured: true, username, url: `https://t.me/${username}` };
}

/** Builds a Telegram /start deep link for a token generated by this module. */
export async function createTelegramBotDeepLink(token: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return null;
  const bot = await getTelegramBotIdentity();
  if (!bot.url) return null;
  return `${bot.url}?start=${token}`;
}

/**
 * Creates a single-use Telegram deep-link token for an active owner. The raw
 * token is intentionally returned only to server-side callers so it can be
 * placed in the Telegram URL; only its HMAC hash is persisted.
 */
export async function createTelegramLinkToken(ownerId: string): Promise<TelegramLinkTokenResult> {
  await ensureRegistrySchema();
  const token = `link_${randomBytes(24).toString('base64url')}`;
  const now = Date.now();
  const expiresAt = now + LINK_TOKEN_TTL_MS;
  const tokenHash = hashTelegramSecret('link-token', token);

  const created = await getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: owners.id })
      .from(owners)
      .where(and(eq(owners.id, ownerId), eq(owners.status, 'active')))
      .for('update');
    if (!owner) return false;

    // One outstanding link is enough. Replacing an older one limits the blast
    // radius if a deep link is copied to another device.
    await tx.delete(telegramLinkTokens).where(and(
      eq(telegramLinkTokens.ownerId, ownerId),
      isNull(telegramLinkTokens.consumedAt),
    ));
    await tx.insert(telegramLinkTokens).values({
      id: crypto.randomUUID(),
      ownerId,
      tokenHash,
      expiresAt,
      createdAt: now,
    });
    return true;
  });

  return created ? { status: 'created', token, expiresAt } : { status: 'owner-not-found' };
}

/**
 * Consumes a /start token from Telegram. It only permits private direct chats
 * (the route validates that before calling this function) and makes a Telegram
 * identity exclusive to one panel owner.
 */
export async function consumeTelegramLinkToken(token: string, identity: TelegramIdentity): Promise<TelegramLinkResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return { status: 'invalid-or-expired' };
  await ensureRegistrySchema();
  const now = Date.now();
  const tokenHash = hashTelegramSecret('link-token', token);

  try {
    return await getDb().transaction(async (tx): Promise<TelegramLinkResult> => {
      const [linkToken] = await tx
        .select()
        .from(telegramLinkTokens)
        .where(and(
          eq(telegramLinkTokens.tokenHash, tokenHash),
          isNull(telegramLinkTokens.consumedAt),
          gt(telegramLinkTokens.expiresAt, now),
        ))
        .for('update');
      if (!linkToken) return { status: 'invalid-or-expired' };

      const [owner] = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(and(eq(owners.id, linkToken.ownerId), eq(owners.status, 'active')))
        .for('update');
      if (!owner) return { status: 'invalid-or-expired' };

      const [linkedToIdentity] = await tx
        .select()
        .from(telegramLinks)
        .where(eq(telegramLinks.telegramUserId, identity.telegramUserId))
        .limit(1)
        .for('update');
      if (linkedToIdentity && linkedToIdentity.ownerId !== owner.id) {
        return { status: 'linked-to-another-owner' };
      }

      const [existingOwnerLink] = await tx
        .select()
        .from(telegramLinks)
        .where(eq(telegramLinks.ownerId, owner.id))
        .limit(1)
        .for('update');

      if (existingOwnerLink && existingOwnerLink.telegramUserId !== identity.telegramUserId) {
        // Never let a second /start silently replace an existing verified
        // account. An explicit unlink/relink flow in the authenticated panel is
        // required for that, which protects a user who leaves a deep link open.
        return { status: 'owner-already-linked' };
      }

      let profile: TelegramLinkProfile;
      if (existingOwnerLink) {
        const [updated] = await tx
          .update(telegramLinks)
          .set({
            telegramUserId: identity.telegramUserId,
            chatId: identity.chatId,
            linkedUsername: identity.linkedUsername,
            displayName: identity.displayName,
            updatedAt: now,
          })
          .where(eq(telegramLinks.id, existingOwnerLink.id))
          .returning();
        profile = profileFromLink(updated);
      } else {
        const [created] = await tx
          .insert(telegramLinks)
          .values({
            id: crypto.randomUUID(),
            ownerId: owner.id,
            telegramUserId: identity.telegramUserId,
            chatId: identity.chatId,
            linkedUsername: identity.linkedUsername,
            displayName: identity.displayName,
            linkedAt: now,
            updatedAt: now,
          })
          .returning();
        profile = profileFromLink(created);
      }

      await tx.update(telegramLinkTokens)
        .set({ consumedAt: now })
        .where(eq(telegramLinkTokens.id, linkToken.id));

      const [domain] = await tx
        .select({ id: subdomains.id, label: subdomains.label })
        .from(subdomains)
        .where(and(eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active')))
        .limit(1);
      await tx.insert(dnsEvents).values({
        id: crypto.randomUUID(),
        subdomainId: domain?.id ?? null,
        domainLabel: domain?.label ?? null,
        actorType: 'owner',
        action: existingOwnerLink ? 'telegram_link_refreshed' : 'telegram_linked',
        details: { verifiedUsername: identity.linkedUsername !== null },
        createdAt: now,
      });

      return linkedToIdentity
        ? { status: 'already-linked-to-owner', profile }
        : { status: 'linked', profile };
    });
  } catch (error) {
    // A concurrent /start for the same Telegram identity can only surface as a
    // database uniqueness conflict. Treat it as a benign "linked elsewhere"
    // result rather than leaking details or consuming the one-time token.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return { status: 'linked-to-another-owner' };
    }
    throw error;
  }
}

export async function getTelegramLinkForOwner(ownerId: string): Promise<TelegramLinkProfile | null> {
  await ensureRegistrySchema();
  const [link] = await getDb()
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.ownerId, ownerId))
    .limit(1);
  return link ? profileFromLink(link) : null;
}

/** Internal lookup for access-key recovery; it never returns the private chat id. */
export async function findTelegramLinkedOwner(linkedUsername: string) {
  const normalized = normalizeTelegramUsername(linkedUsername);
  if (!isValidTelegramUsername(normalized)) return null;
  await ensureRegistrySchema();
  const [link] = await getDb()
    .select({ ownerId: telegramLinks.ownerId, profile: telegramLinks })
    .from(telegramLinks)
    .where(sql`lower(${telegramLinks.linkedUsername}) = ${normalized}`)
    .limit(1);
  return link ? { ownerId: link.ownerId, profile: profileFromLink(link.profile) } : null;
}

/**
 * Creates a hashed, short-lived code bound to one owner + purpose + target.
 * The raw code is server-only: use `sendTelegramVerificationCode` for the
 * normal flow and never put `code` into a JSON response.
 */
export async function createTelegramVerificationChallenge(args: {
  ownerId: string;
  purpose: TelegramVerificationPurpose;
  subject?: string | null;
}): Promise<TelegramVerificationChallengeResult> {
  await ensureRegistrySchema();
  const subject = args.subject?.trim() || null;
  const code = String(randomInt(100_000, 1_000_000));
  const now = Date.now();
  const expiresAt = now + verificationCodeTtlMs(args.purpose);

  return getDb().transaction(async (tx): Promise<TelegramVerificationChallengeResult> => {
    const [link] = await tx
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.ownerId, args.ownerId))
      .limit(1)
      .for('update');
    if (!link) return { status: 'not-linked' };

    // A fresh code invalidates previous active codes for this exact operation.
    // This avoids an old code silently remaining valid after a resend.
    await tx.update(telegramVerificationChallenges)
      .set({ consumedAt: now })
      .where(and(
        challengeFilter(args.ownerId, args.purpose, subject),
        isNull(telegramVerificationChallenges.consumedAt),
      ));
    await tx.insert(telegramVerificationChallenges).values({
      id: crypto.randomUUID(),
      ownerId: args.ownerId,
      telegramLinkId: link.id,
      purpose: args.purpose,
      subject,
      codeHash: challengeCodeHash(args.ownerId, args.purpose, subject, code),
      expiresAt,
      attempts: 0,
      createdAt: now,
    });
    return { status: 'created', code, expiresAt, chatId: link.chatId };
  });
}

function verificationMessage(purpose: TelegramVerificationPurpose, code: string) {
  const action = purpose === 'subdomain_delete'
    ? 'xóa subdomain chính'
    : 'khôi phục access key';
  const ttlMinutes = verificationCodeTtlMs(purpose) / 60_000;
  return [
    'TAKESHI DOMAINS',
    '',
    `Mã xác nhận để ${action}: ${code}`,
    `Mã có hiệu lực trong ${ttlMinutes} phút và chỉ dùng một lần.`,
    'Không gửi mã này cho bất kỳ ai.',
  ].join('\n');
}

/** Generate and deliver a security code without exposing it to the caller. */
export async function sendTelegramVerificationCode(args: {
  ownerId: string;
  purpose: TelegramVerificationPurpose;
  subject?: string | null;
}) {
  const challenge = await createTelegramVerificationChallenge(args);
  if (challenge.status !== 'created') return challenge;

  const delivery = await sendTelegramMessage(
    challenge.chatId,
    verificationMessage(args.purpose, challenge.code),
  );
  if (delivery.sent) return { status: 'sent' as const, expiresAt: challenge.expiresAt };

  // A code that was not delivered must not remain usable. This update is
  // intentionally best-effort: expiry still prevents later use if it races.
  await getDb().update(telegramVerificationChallenges)
    .set({ consumedAt: Date.now() })
    .where(and(
      eq(telegramVerificationChallenges.ownerId, args.ownerId),
      eq(telegramVerificationChallenges.codeHash, challengeCodeHash(
        args.ownerId,
        args.purpose,
        args.subject?.trim() || null,
        challenge.code,
      )),
      isNull(telegramVerificationChallenges.consumedAt),
    ));
  return { status: delivery.configured ? 'delivery-failed' as const : 'bot-not-configured' as const };
}

/** Atomically validate and consume a code. Codes lock after five bad attempts. */
export async function consumeTelegramVerificationCode(args: {
  ownerId: string;
  purpose: TelegramVerificationPurpose;
  subject?: string | null;
  code: string;
}): Promise<TelegramVerificationCheckResult> {
  const subject = args.subject?.trim() || null;
  const code = args.code.trim();
  if (!/^\d{6}$/.test(code)) return { verified: false, attemptsRemaining: MAX_CODE_ATTEMPTS };

  await ensureRegistrySchema();
  const now = Date.now();
  return getDb().transaction(async (tx): Promise<TelegramVerificationCheckResult> => {
    const [challenge] = await tx
      .select()
      .from(telegramVerificationChallenges)
      .where(and(
        challengeFilter(args.ownerId, args.purpose, subject),
        isNull(telegramVerificationChallenges.consumedAt),
        gt(telegramVerificationChallenges.expiresAt, now),
      ))
      .orderBy(desc(telegramVerificationChallenges.createdAt))
      .limit(1)
      .for('update');
    if (!challenge) return { verified: false, attemptsRemaining: 0 };

    const expected = challengeCodeHash(args.ownerId, args.purpose, subject, code);
    if (constantTimeEqual(challenge.codeHash, expected)) {
      await tx.update(telegramVerificationChallenges)
        .set({ consumedAt: now })
        .where(eq(telegramVerificationChallenges.id, challenge.id));
      return { verified: true };
    }

    const attempts = challenge.attempts + 1;
    const attemptsRemaining = Math.max(0, MAX_CODE_ATTEMPTS - attempts);
    await tx.update(telegramVerificationChallenges)
      .set({ attempts, ...(attemptsRemaining === 0 ? { consumedAt: now } : {}) })
      .where(eq(telegramVerificationChallenges.id, challenge.id));
    return { verified: false, attemptsRemaining };
  });
}

/** Deliver optional record-change notifications without exposing a chat id to routes/UI. */
export async function sendTelegramMessageToOwner(ownerId: string, text: string) {
  await ensureRegistrySchema();
  const [link] = await getDb()
    .select({ chatId: telegramLinks.chatId })
    .from(telegramLinks)
    .where(eq(telegramLinks.ownerId, ownerId))
    .limit(1);
  if (!link) return { linked: false, configured: Boolean(botToken()), sent: false };
  const delivery = await sendTelegramMessage(link.chatId, text);
  return { linked: true, ...delivery };
}

export async function hasProcessedTelegramWebhookUpdate(updateId: string) {
  if (!/^\d{1,20}$/.test(updateId)) return false;
  await ensureRegistrySchema();
  const [processed] = await getDb()
    .select({ updateId: telegramWebhookUpdates.updateId })
    .from(telegramWebhookUpdates)
    .where(eq(telegramWebhookUpdates.updateId, updateId))
    .limit(1);
  return Boolean(processed);
}

/** Mark a completed /start update. This intentionally happens after linking. */
export async function markTelegramWebhookUpdateProcessed(updateId: string) {
  if (!/^\d{1,20}$/.test(updateId)) return false;
  await ensureRegistrySchema();
  const inserted = await getDb().insert(telegramWebhookUpdates)
    .values({ updateId, processedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ updateId: telegramWebhookUpdates.updateId });
  return inserted.length > 0;
}

export function isTelegramWebhookSecretValid(receivedSecret: string | null) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expectedSecret || !receivedSecret) return false;
  return constantTimeEqual(expectedSecret, receivedSecret);
}

/** Register this deployment as the Bot API webhook from an authenticated admin action. */
export async function configureTelegramWebhook(webhookUrl: string) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken() || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return { configured: false as const, updated: false as const };
  }

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return { configured: true as const, updated: false as const };
  }
  if (url.protocol !== 'https:') return { configured: true as const, updated: false as const };

  const result = await telegramApiRequest('setWebhook', {
    url: url.toString(),
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  return { configured: result.configured, updated: result.response !== null };
}

async function sendAdminTelegramMessage(text: string): Promise<TelegramSendResult> {
  const config = adminBotConfig();
  if (!config) return { configured: false, sent: false };
  return sendTelegramMessage(config.chatId, text);
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
