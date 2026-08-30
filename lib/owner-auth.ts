import { createHmac, randomBytes } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { owners, ownerSessions, pendingRequestSessions, subdomainRequests } from '@/db/schema';
import { OWNER_ACCESS_KEY_PREFIX } from '@/lib/registry';

const OWNER_COOKIE_NAME = 'takeshi_owner_session';
const PENDING_REQUEST_COOKIE_NAME = 'takeshi_pending_request_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function hashSecret(value: string) {
  const pepper = process.env.REGISTRY_ADMIN_KEY;
  if (!pepper) throw new Error('REGISTRY_ADMIN_KEY is unavailable.');
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function createOwnerAccessKey() {
  return `${OWNER_ACCESS_KEY_PREFIX}k${randomBytes(12).toString('hex')}9`;
}

export function hashOwnerAccessKey(value: string) {
  return hashSecret(value);
}

export function createOwnerSessionRecord(ownerId: string) {
  const rawToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  return {
    token: rawToken,
    record: {
      id: crypto.randomUUID(),
      ownerId,
      tokenHash: hashSecret(rawToken),
      createdAt: now,
      expiresAt: now + SESSION_MAX_AGE_SECONDS * 1_000,
    },
  };
}

/**
 * Mint an owner session only while the supplied key is still the owner's
 * current key.  Locking the owner row closes the race where a stale login can
 * otherwise insert a session after an access-key rotation revoked all sessions.
 */
export async function createOwnerSession(ownerId: string, expectedAccessKeyHash: string) {
  await ensureRegistrySchema();
  const session = createOwnerSessionRecord(ownerId);
  return getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: owners.id })
      .from(owners)
      .where(and(
        eq(owners.id, ownerId),
        eq(owners.accessKeyHash, expectedAccessKeyHash),
        eq(owners.status, 'active'),
      ))
      .for('update');
    if (!owner) return null;

    await tx.insert(ownerSessions).values(session.record);
    return session.token;
  });
}

export function setOwnerSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(OWNER_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearOwnerSessionCookie(response: NextResponse) {
  response.cookies.set(OWNER_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
}

export async function getOwnerSession(request: NextRequest) {
  const token = request.cookies.get(OWNER_COOKIE_NAME)?.value;
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
  const token = request.cookies.get(OWNER_COOKIE_NAME)?.value;
  if (!token) return;
  await ensureRegistrySchema();
  await getDb().delete(ownerSessions).where(eq(ownerSessions.tokenHash, hashSecret(token)));
}

export async function createPendingRequestSession(requestId: string) {
  await ensureRegistrySchema();
  const rawToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  await getDb().insert(pendingRequestSessions).values({
    id: crypto.randomUUID(),
    requestId,
    tokenHash: hashSecret(rawToken),
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1_000,
  });
  return rawToken;
}

export function setPendingRequestSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(PENDING_REQUEST_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearPendingRequestSessionCookie(response: NextResponse) {
  response.cookies.set(PENDING_REQUEST_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
}

export async function getPendingRequestSession(request: NextRequest) {
  const token = request.cookies.get(PENDING_REQUEST_COOKIE_NAME)?.value;
  if (!token) return null;
  await ensureRegistrySchema();
  const now = Date.now();
  const rows = await getDb()
    .select({ request: subdomainRequests, sessionId: pendingRequestSessions.id })
    .from(pendingRequestSessions)
    .innerJoin(subdomainRequests, eq(pendingRequestSessions.requestId, subdomainRequests.id))
    .where(and(eq(pendingRequestSessions.tokenHash, hashSecret(token)), gt(pendingRequestSessions.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

export async function removePendingRequestSession(request: NextRequest) {
  const token = request.cookies.get(PENDING_REQUEST_COOKIE_NAME)?.value;
  if (!token) return;
  await ensureRegistrySchema();
  await getDb().delete(pendingRequestSessions).where(eq(pendingRequestSessions.tokenHash, hashSecret(token)));
}

export async function removePendingRequestSessionsForRequest(requestId: string) {
  await ensureRegistrySchema();
  await getDb().delete(pendingRequestSessions).where(eq(pendingRequestSessions.requestId, requestId));
}
