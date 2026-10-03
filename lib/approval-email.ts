import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { managedDomains, owners, subdomains, subdomainRequests } from '@/db/schema';
import { sendApprovalEmail } from '@/lib/approval-email-message';
import { createRequestAccessKey, hashOwnerAccessKey } from '@/lib/owner-auth';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import { isValidNotificationEmail } from '@/lib/registry';

export type ApprovalEmailResult = 'accepted' | 'not_requested' | 'not_configured' | 'failed' | 'busy' | 'manual_check' | 'key_changed' | 'inactive';

/** Runs only after DNS activation commits. Failure must never roll back DNS. */
export async function notifyApprovedRequest(requestId: string): Promise<ApprovalEmailResult> {
  try {
    return await deliver(requestId);
  } catch {
    console.error('Approval email could not be processed', { requestId });
    return 'failed';
  }
}

async function deliver(requestId: string): Promise<ApprovalEmailResult> {
  const db = getDb();
  const row = await db.query.subdomainRequests.findFirst({ where: eq(subdomainRequests.id, requestId) });
  if (!row || row.status !== 'active') return 'inactive';
  if (!row.notificationEmail) return 'not_requested';
  if (row.approvalEmailSentAt) return 'accepted';

  const now = Date.now();
  if (row.approvalEmailAttemptedAt && row.approvalEmailAttemptedAt > now - 60_000) return 'busy';
  // Resend retains idempotency keys for 24h. Only an uncertain stale outcome
  // needs a manual check; explicit provider rejections are safe to retry after
  // the sender configuration has been corrected.
  const uncertainPreviousAttempt = !row.approvalEmailError
    || row.approvalEmailError === 'delivery_unknown'
    || /^provider_5\d\d$/.test(row.approvalEmailError);
  if (uncertainPreviousAttempt && row.approvalEmailFirstAttemptAt && row.approvalEmailFirstAttemptAt < now - 23 * 60 * 60_000) return 'manual_check';

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    await db.update(subdomainRequests).set({ approvalEmailError: 'not_configured' })
      .where(and(eq(subdomainRequests.id, requestId), isNull(subdomainRequests.approvalEmailSentAt)));
    return 'not_configured';
  }
  if (!isValidNotificationEmail(row.notificationEmail)) return 'failed';
  const parent = await db.query.managedDomains.findFirst({ where: eq(managedDomains.id, row.parentDomainId), columns: { hostname: true } });
  if (!parent) return 'failed';
  const generatedKey = createRequestAccessKey(row.id);
  const accessKey = row.requestedAccessKeyHash === hashOwnerAccessKey(generatedKey) ? generatedKey : null;
  if (accessKey) {
    const [activeOwner] = await db.select({ accessKeyHash: owners.accessKeyHash })
      .from(subdomains).innerJoin(owners, eq(subdomains.ownerId, owners.id))
      .where(eq(subdomains.requestId, row.id)).limit(1);
    // A rotated key must never be resent as if it still grants access.
    if (activeOwner?.accessKeyHash !== row.requestedAccessKeyHash) return 'key_changed';
  }

  // Atomic lease prevents parallel approval/retry clicks from sending twice.
  const [claimed] = await db.update(subdomainRequests).set({ approvalEmailAttemptedAt: now, approvalEmailError: null })
    .where(and(
      eq(subdomainRequests.id, requestId), eq(subdomainRequests.status, 'active'),
      isNull(subdomainRequests.approvalEmailSentAt),
      or(isNull(subdomainRequests.approvalEmailAttemptedAt), lt(subdomainRequests.approvalEmailAttemptedAt, now - 60_000)),
    )).returning({ id: subdomainRequests.id });
  if (!claimed) return 'busy';
  const limit = await enforceRegistryScopedRateLimit('approval-email', row.notificationEmail, 5, 24 * 60 * 60_000);
  if (!limit.allowed) {
    await db.update(subdomainRequests).set({ approvalEmailError: 'recipient_rate_limit' }).where(eq(subdomainRequests.id, requestId));
    return 'failed';
  }
  await db.update(subdomainRequests).set({
    approvalEmailFirstAttemptAt: sql`coalesce(${subdomainRequests.approvalEmailFirstAttemptAt}, ${now})`,
  }).where(eq(subdomainRequests.id, requestId));
  // Serialize delivery of a generated key with key rotation. A stale key must
  // never be presented as the current one after a reset committed.
  const result = await db.transaction(async (tx) => {
    if (accessKey) {
      const [domain] = await tx.select({ ownerId: subdomains.ownerId }).from(subdomains).where(eq(subdomains.requestId, row.id)).limit(1);
      if (!domain) return null;
      const [owner] = await tx.select({ accessKeyHash: owners.accessKeyHash }).from(owners).where(eq(owners.id, domain.ownerId)).for('update');
      if (owner?.accessKeyHash !== row.requestedAccessKeyHash) return null;
      const [current] = await tx.select({ status: subdomainRequests.status }).from(subdomainRequests).where(eq(subdomainRequests.id, row.id));
      if (current?.status !== 'active') return null;
    }
    return sendApprovalEmail({ requestId, email: row.notificationEmail!,
      hostname: `${row.subdomain}.${parent.hostname}`, language: row.notificationLanguage, accessKey, apiKey, from });
  });
  if (!result) {
    await db.update(subdomainRequests).set({ approvalEmailError: 'key_changed' }).where(eq(subdomainRequests.id, requestId));
    return 'key_changed';
  }
  await db.update(subdomainRequests).set(result.accepted
    ? { approvalEmailSentAt: Date.now(), approvalEmailError: null }
    : { approvalEmailError: result.error })
    .where(and(eq(subdomainRequests.id, requestId), eq(subdomainRequests.approvalEmailAttemptedAt, now)));
  return result.accepted ? 'accepted' : 'failed';
}
