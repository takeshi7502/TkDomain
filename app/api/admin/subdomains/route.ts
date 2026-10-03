import { after, NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { ensureRegistrySchema, getDb } from '@/db';
import { dnsOperations } from '@/db/schema';
import { isAdminAuthorized } from '@/lib/admin-auth';
import { beginAdminSubdomainDeletion, runDnsOperation } from '@/lib/dns-operations';
import { errorResponse, HttpError, readJson, trustedMutation, validId } from '@/lib/http';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

export const maxDuration = 120;

export async function DELETE(request: NextRequest) {
  if (!trustedMutation(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (!isAdminAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const deadline = Date.now() + 110_000;
  try {
    const body = await readJson(request);
    if (!validId(body.subdomainId) || !validId(body.operationId) || typeof body.confirmation !== 'string'
      || body.confirmation.length > 253 || typeof body.reason !== 'string' || typeof body.notifyEmail !== 'boolean') throw new HttpError('Thông tin xác nhận xoá không hợp lệ.');
    const limit = await enforceRegistryRateLimit(request, 'admin-subdomain-delete', 12, 60_000);
    if (!limit.allowed) return NextResponse.json({ error: 'Thao tác quá nhanh. Hãy chờ một phút.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
    await ensureRegistrySchema();
    const op = await beginAdminSubdomainDeletion({ id: body.operationId, subdomainId: body.subdomainId,
      confirmation: body.confirmation, reason: body.reason, notifyEmail: body.notifyEmail });
    const result = await runDnsOperation(op.id);
    if (result.pending) after(async () => {
      try {
        // Drain only this confirmed deletion, in bounded provider batches.
        for (let batch = 0; batch < 10 && Date.now() < deadline - 55_000; batch++) {
          const [waiting] = await getDb().select({ status: dnsOperations.status, leaseUntil: dnsOperations.leaseUntil }).from(dnsOperations).where(eq(dnsOperations.id, op.id));
          if (!waiting || waiting.status !== 'pending' || waiting.leaseUntil >= Date.now()) break;
          if (!(await runDnsOperation(op.id)).pending) break;
        }
      } catch { console.warn('Admin subdomain deletion deferred.'); }
    });
    return NextResponse.json(result, { status: result.pending ? 202 : 200 });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    return NextResponse.json({ error: 'Không thể hoàn tất xoá lúc này. Hãy tải lại để kiểm tra trạng thái đồng bộ.' }, { status: 503 });
  }
}
