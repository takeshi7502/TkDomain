import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { dnsEvents, owners, ownerSessions, subdomainRequests, subdomains } from '@/db/schema';
import {
  clearPendingRequestSessionCookie,
  createOwnerSessionRecord,
  getOwnerSession,
  hashOwnerAccessKey,
  setOwnerSessionCookie,
} from '@/lib/owner-auth';
import { isValidOwnerAccessKey } from '@/lib/registry';
import { enforceRegistryRateLimit } from '@/lib/rate-limit';

type RotationResult =
  | { type: 'success'; token: string }
  | { type: 'current-key-invalid' }
  | { type: 'new-key-unavailable' };

function isUniqueViolation(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

/**
 * Rotate an owner's access key. The row-level owner lock is shared with the
 * login flow, so an old key can neither create a session after this rotation
 * nor survive the session revocation performed below.
 */
export async function PATCH(request: NextRequest) {
  const limit = await enforceRegistryRateLimit(request, 'owner-access-key-change', 6, 15 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many access-key changes. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { currentAccessKey?: unknown; newAccessKey?: unknown };
  try {
    body = await request.json() as { currentAccessKey?: unknown; newAccessKey?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const currentAccessKey = typeof body.currentAccessKey === 'string' ? body.currentAccessKey.trim() : '';
  const newAccessKey = typeof body.newAccessKey === 'string' ? body.newAccessKey.trim() : '';
  if (!isValidOwnerAccessKey(currentAccessKey) || !isValidOwnerAccessKey(newAccessKey)) {
    return NextResponse.json({ error: 'Access key không đúng định dạng.' }, { status: 400 });
  }
  if (currentAccessKey === newAccessKey) {
    return NextResponse.json({ error: 'Access key mới phải khác access key hiện tại.' }, { status: 400 });
  }

  await ensureRegistrySchema();
  const db = getDb();
  const currentAccessKeyHash = hashOwnerAccessKey(currentAccessKey);
  const newAccessKeyHash = hashOwnerAccessKey(newAccessKey);
  const freshSession = createOwnerSessionRecord(session.owner.id);
  const now = Date.now();

  let result: RotationResult;
  try {
    result = await db.transaction(async (tx): Promise<RotationResult> => {
      // The lock makes rotation and any old-key login serialize in a safe order.
      const [owner] = await tx
        .select({ id: owners.id, accessKeyHash: owners.accessKeyHash })
        .from(owners)
        .where(and(eq(owners.id, session.owner.id), eq(owners.status, 'active')))
        .for('update');
      if (!owner || owner.accessKeyHash !== currentAccessKeyHash) return { type: 'current-key-invalid' };

      const [ownerUsingNewKey] = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(eq(owners.accessKeyHash, newAccessKeyHash))
        .limit(1);
      if (ownerUsingNewKey && ownerUsingNewKey.id !== owner.id) return { type: 'new-key-unavailable' };

      // A rejected request can still be opened with its key to view its status,
      // so reserve those keys as well and avoid an ambiguous future login.
      const [requestUsingNewKey] = await tx
        .select({ id: subdomainRequests.id })
        .from(subdomainRequests)
        .where(and(
          eq(subdomainRequests.requestedAccessKeyHash, newAccessKeyHash),
          inArray(subdomainRequests.status, ['pending', 'active', 'rejected']),
        ))
        .limit(1);
      if (requestUsingNewKey) return { type: 'new-key-unavailable' };

      const changed = await tx
        .update(owners)
        .set({ accessKeyHash: newAccessKeyHash, updatedAt: now })
        .where(and(
          eq(owners.id, owner.id),
          eq(owners.accessKeyHash, currentAccessKeyHash),
          eq(owners.status, 'active'),
        ))
        .returning({ id: owners.id });
      if (changed.length === 0) return { type: 'current-key-invalid' };

      const [domain] = await tx
        .select({ id: subdomains.id, label: subdomains.label })
        .from(subdomains)
        .where(and(eq(subdomains.ownerId, owner.id), eq(subdomains.status, 'active')))
        .limit(1);

      await tx.delete(ownerSessions).where(eq(ownerSessions.ownerId, owner.id));
      await tx.insert(ownerSessions).values(freshSession.record);
      await tx.insert(dnsEvents).values({
        id: crypto.randomUUID(),
        subdomainId: domain?.id ?? null,
        domainLabel: domain?.label ?? null,
        actorType: 'owner',
        action: 'owner_access_key_changed',
        details: { invalidatedSessions: true },
        createdAt: now,
      });

      return { type: 'success', token: freshSession.token };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: 'Access key mới đang được sử dụng. Hãy chọn key khác.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Không thể đổi access key lúc này. Hãy thử lại.' }, { status: 500 });
  }

  if (result.type === 'current-key-invalid') {
    return NextResponse.json({ error: 'Access key hiện tại không đúng hoặc đã vừa được thay đổi.' }, { status: 401 });
  }
  if (result.type === 'new-key-unavailable') {
    return NextResponse.json({ error: 'Access key mới đang được sử dụng hoặc đã được giữ cho một yêu cầu khác.' }, { status: 409 });
  }

  const response = NextResponse.json({ ok: true });
  clearPendingRequestSessionCookie(response);
  setOwnerSessionCookie(response, result.token);
  return response;
}
