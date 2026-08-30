import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';

import { ensureRegistrySchema, getSql } from '@/db';

function clientAddress(request: NextRequest) {
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown-client';
}

function rateLimitKey(request: NextRequest, action: string) {
  const secret = process.env.REGISTRY_ADMIN_KEY ?? 'takeshi-registry-rate-limit';
  return createHmac('sha256', secret).update(`${action}:${clientAddress(request)}`).digest('hex');
}

function scopedRateLimitKey(action: string, scope: string) {
  const secret = process.env.REGISTRY_ADMIN_KEY ?? 'takeshi-registry-rate-limit';
  return createHmac('sha256', secret).update(`${action}:scope:${scope}`).digest('hex');
}

async function enforceRateLimit(storageKey: string, limit: number, windowMs: number) {
  await ensureRegistrySchema();
  const now = Date.now();
  const [row] = await getSql().query(
    `INSERT INTO registry_rate_limits (key, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN registry_rate_limits.window_start <= $3 THEN 1 ELSE registry_rate_limits.hits + 1 END,
       window_start = CASE WHEN registry_rate_limits.window_start <= $3 THEN $2 ELSE registry_rate_limits.window_start END
     RETURNING hits, window_start`,
    [storageKey, now, now - windowMs],
  ) as Array<{ hits: number; window_start: number }>;
  const retryAfterSeconds = Math.max(1, Math.ceil((Number(row.window_start) + windowMs - now) / 1_000));
  return { allowed: Number(row.hits) <= limit, retryAfterSeconds };
}

/** Limit a public action by the caller's network address. */
export function enforceRegistryRateLimit(request: NextRequest, action: string, limit: number, windowMs: number) {
  return enforceRateLimit(rateLimitKey(request, action), limit, windowMs);
}

/**
 * Add a second, private limit for a durable entity such as an owner ID. This
 * prevents a single linked Telegram chat from receiving an unlimited number
 * of recovery/delete codes from many different IP addresses.
 */
export function enforceRegistryScopedRateLimit(action: string, scope: string, limit: number, windowMs: number) {
  return enforceRateLimit(scopedRateLimitKey(action, scope), limit, windowMs);
}
