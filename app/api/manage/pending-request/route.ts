import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { subdomainRequests } from '@/db/schema';
import {
  clearPendingRequestSessionCookie,
  getPendingRequestSession,
  removePendingRequestSessionsForRequest,
} from '@/lib/owner-auth';
import { BASE_DOMAIN } from '@/lib/registry';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

const REVIEW_LEASE_MS = 10 * 60_000;

export async function DELETE(request: NextRequest) {
  const limit = await enforceRegistryRateLimit(request, 'pending-request-cancel', 10, 15 * 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Bạn đã thử quá nhiều lần. Hãy chờ ít phút rồi thử lại.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });

  const session = await getPendingRequestSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const requestRecord = session.request;
  const hostname = `${requestRecord.subdomain}.${BASE_DOMAIN}`;

  let body: { confirmation?: string };
  try { body = await request.json() as { confirmation?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Nhập chính xác ${hostname} để xác nhận hủy.` }, { status: 400 });

  const now = Date.now();
  const cancelled = await getDb()
    .update(subdomainRequests)
    .set({ status: 'cancelled', cancelledAt: now, reviewedAt: now, reviewerNote: 'Người đăng ký đã tự hủy yêu cầu.' })
    .where(and(
      eq(subdomainRequests.id, requestRecord.id),
      eq(subdomainRequests.status, 'pending'),
      or(
        isNull(subdomainRequests.reviewStartedAt),
        lt(subdomainRequests.reviewStartedAt, now - REVIEW_LEASE_MS),
      ),
    ))
    .returning({ id: subdomainRequests.id });

  if (cancelled.length === 0) {
    return NextResponse.json({ error: 'Yêu cầu đã đổi trạng thái trong lúc xử lý. Hãy tải lại trang để xem trạng thái mới.' }, { status: 409 });
  }

  await removePendingRequestSessionsForRequest(requestRecord.id);
  const response = NextResponse.json({ ok: true, hostname, status: 'cancelled' });
  clearPendingRequestSessionCookie(response);
  return response;
}
