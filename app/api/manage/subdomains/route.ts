import { readJson, errorResponse } from '@/lib/http';
import { and, eq, inArray } from 'drizzle-orm';
import { after, NextRequest, NextResponse } from 'next/server';

import { getDb } from '@/db';
import { managedDomains, subdomains } from '@/db/schema';
import { beginDnsOperation, releaseInProgress, resumeDnsOperations, runDnsOperation } from '@/lib/dns-operations';
import { HttpError, validId } from '@/lib/http';
import { getOwnerSession } from '@/lib/owner-auth';
import { enforceRegistryRateLimit, enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import {
  consumeTelegramVerificationCode,
  getTelegramLinkForOwner,
  sendTelegramVerificationCode,
} from '@/lib/telegram';

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return !origin || origin === request.nextUrl.origin;
}

async function ownedActiveSubdomain(ownerId: string, subdomainId: string) {
  const rows = await getDb()
    .select({ domain: subdomains, parentDomain: managedDomains })
    .from(subdomains)
    .innerJoin(managedDomains, eq(subdomains.parentDomainId, managedDomains.id))
    .where(and(eq(subdomains.id, subdomainId), eq(subdomains.ownerId, ownerId), inArray(subdomains.status, ['active', 'deleting'])))
    .limit(1);
  return rows[0] ?? null;
}

/** Request an out-of-band deletion code when the owner has linked Telegram. */
export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const [ipLimit, ownerLimit] = await Promise.all([
    enforceRegistryRateLimit(request, 'subdomain-delete-code', 4, 15 * 60_000),
    enforceRegistryScopedRateLimit('subdomain-delete-code', session.owner.id, 3, 15 * 60_000),
  ]);
  if (!ipLimit.allowed || !ownerLimit.allowed) {
    return NextResponse.json(
      { error: 'Bạn đã yêu cầu quá nhiều mã xác minh. Hãy chờ ít phút rồi thử lại.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
    );
  }

  let body: { subdomainId?: unknown; confirmation?: unknown };
  try { body = await readJson(request) as typeof body; } catch (error) { return errorResponse(error); }
  const subdomainId = typeof body.subdomainId === 'string' ? body.subdomainId : '';
  if (!subdomainId) return NextResponse.json({ error: 'Missing subdomain.' }, { status: 400 });

  const domain = await ownedActiveSubdomain(session.owner.id, subdomainId);
  if (!domain) return NextResponse.json({ error: 'Subdomain not found.' }, { status: 404 });
  const hostname = `${domain.domain.label}.${domain.parentDomain.hostname}`;
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Type ${hostname} exactly to confirm deletion.` }, { status: 400 });

  const delivery = await sendTelegramVerificationCode({
    ownerId: session.owner.id,
    purpose: 'subdomain_delete',
    subject: domain.domain.id,
  });
  if (delivery.status === 'not-linked') return NextResponse.json({ ok: true, otpRequired: false });
  if (delivery.status === 'bot-not-configured') {
    return NextResponse.json({ error: 'Bot Telegram chưa được cấu hình. Liên hệ Admin để hoàn tất hoặc hỗ trợ xóa subdomain.' }, { status: 503 });
  }
  if (delivery.status === 'delivery-failed') {
    return NextResponse.json({ error: 'Không gửi được mã Telegram lúc này. Hãy thử lại sau.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, otpRequired: true, expiresAt: delivery.expiresAt });
}

export async function DELETE(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { subdomainId?: string; confirmation?: string; code?: string };
  try { body = await readJson(request) as { subdomainId?: string; confirmation?: string; code?: string }; } catch (error) { return errorResponse(error); }
  if (!validId(body.subdomainId) || (body.code !== undefined && typeof body.code !== 'string')) return NextResponse.json({ error: 'Invalid subdomain or code.' }, { status: 400 });
  const limit = await enforceRegistryScopedRateLimit('subdomain-release', session.owner.id, 6, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Hãy chờ một phút trước khi thử lại.' }, { status: 429 });

  const domain = await ownedActiveSubdomain(session.owner.id, body.subdomainId);
  if (!domain) return NextResponse.json({ error: 'Subdomain not found.' }, { status: 404 });
  if (!domain.parentDomain.cloudflareZoneId) return NextResponse.json({ error: 'Cloudflare chưa được cấu hình cho domain gốc này. Liên hệ Admin.' }, { status: 409 });

  const hostname = `${domain.domain.label}.${domain.parentDomain.hostname}`;
  if (body.confirmation !== hostname) return NextResponse.json({ error: `Type ${hostname} exactly to confirm deletion.` }, { status: 400 });

  const ongoing = await releaseInProgress(session.owner.id, domain.domain.id);
  if (ongoing) {
    const result = await runDnsOperation(ongoing);
    return NextResponse.json(result, { status: result.pending ? 202 : 200 });
  }
  const linkedTelegram = await getTelegramLinkForOwner(session.owner.id);
  if (linkedTelegram) {
    const [ipLimit, ownerLimit] = await Promise.all([
      enforceRegistryRateLimit(request, 'subdomain-delete-verify', 8, 15 * 60_000),
      enforceRegistryScopedRateLimit('subdomain-delete-verify', session.owner.id, 8, 15 * 60_000),
    ]);
    if (!ipLimit.allowed || !ownerLimit.allowed) {
      return NextResponse.json(
        { error: 'Bạn đã thử xác minh quá nhiều lần. Hãy yêu cầu mã mới sau ít phút.' },
        { status: 429, headers: { 'Retry-After': String(Math.max(ipLimit.retryAfterSeconds, ownerLimit.retryAfterSeconds)) } },
      );
    }

    const verification = await consumeTelegramVerificationCode({
      ownerId: session.owner.id,
      purpose: 'subdomain_delete',
      subject: domain.domain.id,
      code: body.code ?? '',
    });
    if (!verification.verified) {
      const suffix = verification.attemptsRemaining > 0
        ? ` Bạn còn ${verification.attemptsRemaining} lần thử.`
        : ' Hãy yêu cầu mã mới.';
      return NextResponse.json({ error: `Mã Telegram không đúng hoặc đã hết hạn.${suffix}` }, { status: 401 });
    }
  }

  try {
    const op = await beginDnsOperation({ id: crypto.randomUUID(), kind: 'release', ownerId: session.owner.id, subdomainId: domain.domain.id });
    const result = await runDnsOperation(op.id);
    if (result.pending) after(async () => { try { await resumeDnsOperations(session.owner.id, 1); } catch { console.warn('Subdomain release deferred.'); } });
    return NextResponse.json(result, { status: result.pending ? 202 : 200 });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    return NextResponse.json({ error: 'Không thể xử lý yêu cầu xóa. Hãy tải lại panel.' }, { status: 503 });
  }
}
