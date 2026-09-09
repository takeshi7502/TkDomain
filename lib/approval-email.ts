import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { managedDomains, subdomainRequests } from '@/db/schema';
import { sendApprovalEmail } from '@/lib/approval-email-message';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import { isValidNotificationEmail } from '@/lib/registry';

export type ApprovalEmailResult = 'accepted' | 'not_requested' | 'not_configured' | 'failed' | 'busy' | 'manual_check' | 'inactive';

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
  const result = await sendApprovalEmail({ requestId, email: row.notificationEmail,
    hostname: `${row.subdomain}.${parent.hostname}`, language: row.notificationLanguage, apiKey, from });
  await db.update(subdomainRequests).set(result.accepted
    ? { approvalEmailSentAt: Date.now(), approvalEmailError: null }
    : { approvalEmailError: result.error })
    .where(and(eq(subdomainRequests.id, requestId), eq(subdomainRequests.approvalEmailAttemptedAt, now)));
  return result.accepted ? 'accepted' : 'failed';
}
