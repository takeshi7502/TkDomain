import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

const ADMIN_SESSION_COOKIE = 'takeshi_admin_session';
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function adminSecret() {
  return process.env.REGISTRY_ADMIN_KEY ?? '';
}

function signature(value: string) {
  const secret = adminSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidAdminKey(value: string | null | undefined) {
  const secret = adminSecret();
  return Boolean(secret && value && safeEqual(value, secret));
}

export function createAdminSessionToken() {
  const expiresAt = Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1_000;
  const nonce = randomBytes(24).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  const signed = signature(payload);
  if (!signed) throw new Error('REGISTRY_ADMIN_KEY is unavailable.');
  return `${payload}.${signed}`;
}

export function hasAdminSession(request: NextRequest) {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresAtValue, nonce, tokenSignature] = parts;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !nonce || !tokenSignature) return false;

  const expectedSignature = signature(`${expiresAtValue}.${nonce}`);
  return Boolean(expectedSignature && safeEqual(tokenSignature, expectedSignature));
}

export function isAdminAuthorized(request: NextRequest) {
  return isValidAdminKey(request.headers.get('x-registry-admin-key')) || hasAdminSession(request);
}

export function setAdminSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}
