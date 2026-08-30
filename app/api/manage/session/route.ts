import { desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { owners, subdomainRequests, subdomains } from '@/db/schema';
import {
  clearOwnerSessionCookie,
  clearPendingRequestSessionCookie,
  createOwnerSession,
  createPendingRequestSession,
  getOwnerSession,
  getPendingRequestSession,
  hashOwnerAccessKey,
  removeOwnerSession,
  removePendingRequestSession,
  setOwnerSessionCookie,
  setPendingRequestSessionCookie,
} from '@/lib/owner-auth';
import { BASE_DOMAIN } from '@/lib/registry';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

function ownerProfile(owner: typeof owners.$inferSelect) {
  return { telegramUsername: owner.telegramUsername };
}

async function ownerPayload(owner: typeof owners.$inferSelect) {
  const domains = await getDb()
    .select({ id: subdomains.id, label: subdomains.label, status: subdomains.status })
    .from(subdomains)
    .where(eq(subdomains.ownerId, owner.id));
  return { type: 'owner' as const, owner: ownerProfile(owner), subdomains: domains };
}

function requestPayload(requestRecord: typeof subdomainRequests.$inferSelect) {
  return {
    type: requestRecord.status === 'pending' ? 'pending' as const : 'rejected' as const,
    request: {
      id: requestRecord.id,
      hostname: `${requestRecord.subdomain}.${BASE_DOMAIN}`,
      cnameTarget: requestRecord.cnameTarget,
      telegramUsername: requestRecord.telegramUsername,
      status: requestRecord.status,
      createdAt: requestRecord.createdAt,
      reviewedAt: requestRecord.reviewedAt,
      reviewerNote: requestRecord.reviewerNote,
    },
  };
}

export async function GET(request: NextRequest) {
  const activeOwnerSession = await getOwnerSession(request);
  if (activeOwnerSession) return NextResponse.json(await ownerPayload(activeOwnerSession.owner));

  const requestSession = await getPendingRequestSession(request);
  if (!requestSession) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const requestRecord = requestSession.request;
  if (requestRecord.status === 'active' && requestRecord.requestedAccessKeyHash) {
    const owner = await getDb().query.owners.findFirst({ where: eq(owners.accessKeyHash, requestRecord.requestedAccessKeyHash) });
    if (owner?.status === 'active') {
      const token = await createOwnerSession(owner.id, requestRecord.requestedAccessKeyHash);
      if (token) {
        await removePendingRequestSession(request);
        const response = NextResponse.json(await ownerPayload(owner));
        clearPendingRequestSessionCookie(response);
        setOwnerSessionCookie(response, token);
        return response;
      }
    }
  }

  if (requestRecord.status === 'pending' || requestRecord.status === 'rejected') {
    return NextResponse.json(requestPayload(requestRecord));
  }

  const response = NextResponse.json({ error: 'Phiên theo dõi yêu cầu này không còn hợp lệ.' }, { status: 401 });
  clearPendingRequestSessionCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  const limit = await enforceRegistryRateLimit(request, 'owner-login', 8, 15 * 60_000);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many access-key attempts. Please try again later.' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } });
  let body: { accessKey?: string };
  try { body = await request.json() as { accessKey?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  const accessKey = body.accessKey?.trim();
  if (!accessKey || accessKey.length > 200) return NextResponse.json({ error: 'Access key không hợp lệ.' }, { status: 400 });

  await ensureRegistrySchema();
  const db = getDb();
  const accessKeyHash = hashOwnerAccessKey(accessKey);
  const owner = await db.query.owners.findFirst({ where: eq(owners.accessKeyHash, accessKeyHash) });
  if (owner?.status === 'active') {
    const token = await createOwnerSession(owner.id, accessKeyHash);
    if (token) {
      const response = NextResponse.json({ ok: true, ...(await ownerPayload(owner)) });
      clearPendingRequestSessionCookie(response);
      setOwnerSessionCookie(response, token);
      return response;
    }
  }

  const [requestRecord] = await db
    .select()
    .from(subdomainRequests)
    .where(eq(subdomainRequests.requestedAccessKeyHash, accessKeyHash))
    .orderBy(desc(subdomainRequests.createdAt))
    .limit(1);
  if (!requestRecord || (requestRecord.status !== 'pending' && requestRecord.status !== 'rejected')) {
    return NextResponse.json({ error: 'Access key không đúng hoặc đã bị thu hồi.' }, { status: 401 });
  }

  const token = await createPendingRequestSession(requestRecord.id);
  const response = NextResponse.json({ ok: true, ...requestPayload(requestRecord) });
  clearOwnerSessionCookie(response);
  setPendingRequestSessionCookie(response, token);
  return response;
}

export async function DELETE(request: NextRequest) {
  await Promise.all([removeOwnerSession(request), removePendingRequestSession(request)]);
  const response = NextResponse.json({ ok: true });
  clearOwnerSessionCookie(response);
  clearPendingRequestSessionCookie(response);
  return response;
}
