import { readJson, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';

import {
  clearAdminSessionCookie,
  createAdminSessionToken,
  hasAdminSession,
  isValidAdminKey,
  setAdminSessionCookie,
} from '@/lib/admin-auth';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  if (!hasAdminSession(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  return NextResponse.json({ ok: true, authenticated: true });
}

export async function POST(request: NextRequest) {
  const limit = await enforceRegistryRateLimit(request, 'admin-login', 8, 15 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many admin-key attempts. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  let body: { adminKey?: string };
  try {
    body = await readJson(request) as { adminKey?: string };
  } catch (error) { return errorResponse(error); }

  const suppliedKey = (typeof body.adminKey === 'string' ? body.adminKey.trim() : '') ?? request.headers.get('x-registry-admin-key');
  if (!isValidAdminKey(suppliedKey)) return NextResponse.json({ error: 'Admin key không đúng.' }, { status: 401 });

  const response = NextResponse.json({ ok: true, authenticated: true });
  setAdminSessionCookie(response, createAdminSessionToken());
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearAdminSessionCookie(response);
  return response;
}
