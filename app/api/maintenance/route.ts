import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ensureRegistrySchema } from '@/db';
import { isAdminAuthorized } from '@/lib/admin-auth';
import { trustedMutation } from '@/lib/http';
import { runMaintenance } from '@/lib/maintenance';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function cronAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret === '[SENSITIVE]') return false;
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function run(retryStalled = false) {
  try {
    await ensureRegistrySchema();
    const limit = await enforceRegistryScopedRateLimit('maintenance', 'global', 1, 60_000);
    if (!limit.allowed) return NextResponse.json({ error: 'Hãy đợi một phút trước khi kiểm tra lại.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
    return NextResponse.json(await runMaintenance(retryStalled));
  } catch {
    console.warn('Maintenance was deferred.');
    return NextResponse.json({ error: 'Kiểm tra đồng bộ chưa hoàn tất. Thử lại sau.' }, { status: 503 });
  }
}
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  return run();
}
export async function POST(request: NextRequest) {
  if (!trustedMutation(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (!isAdminAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  return run(true);
}
