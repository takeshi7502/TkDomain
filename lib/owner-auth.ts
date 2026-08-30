import { createHmac, randomBytes } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { owners, ownerSessions } from '@/db/schema';

const COOKIE_NAME = 'takeshi_owner_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function hashSecret(value: string) {
  const pepper = process.env.REGISTRY_ADMIN_KEY;
  if (!pepper) throw new Error('REGISTRY_ADMIN_KEY is unavailable.');
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function createOwnerAccessKey() {
  return `td_owner_${randomBytes(24).toString('base64url')}`;
}

export function hashOwnerAccessKey(value: string) {
  return hashSecret(value);
}

export async function createOwnerSession(ownerId: string) {
  await ensureRegistrySchema();
  const rawToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  await getDb().insert(ownerSessions).values({
    id: crypto.randomUUID(),
    ownerId,
    tokenHash: hashSecret(rawToken),
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1_000,
  });
  return rawToken;
}

export function setOwnerSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearOwnerSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
}

export async function getOwnerSession(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  await ensureRegistrySchema();
  const now = Date.now();
  const rows = await getDb()
    .select({ owner: owners, sessionId: ownerSessions.id })
    .from(ownerSessions)
    .innerJoin(owners, eq(ownerSessions.ownerId, owners.id))
    .where(and(eq(ownerSessions.tokenHash, hashSecret(token)), gt(ownerSessions.expiresAt, now), eq(owners.status, 'active')))
    .limit(1);
  return rows[0] ?? null;
}

export async function removeOwnerSession(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return;
  await ensureRegistrySchema();
  await getDb().delete(ownerSessions).where(eq(ownerSessions.tokenHash, hashSecret(token)));
}
