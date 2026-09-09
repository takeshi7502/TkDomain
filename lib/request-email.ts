import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { getDb } from '@/db';
import { managedDomains, subdomainRequests } from '@/db/schema';
import { sendRequestReceivedEmail } from '@/lib/approval-email-message';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import { isValidNotificationEmail } from '@/lib/registry';

export type RequestEmailResult = 'accepted' | 'not_configured' | 'failed' | 'busy';

/** Sends only after the request insert commits. A mail failure never removes the request. */
export async function notifyRequestReceived(requestId: string): Promise<RequestEmailResult> {
  try {
    return await deliver(requestId);
  } catch {
    console.error('Request receipt email could not be processed', { requestId });
    return 'failed';
  }
}

async function deliver(requestId: string): Promise<RequestEmailResult> {
  const db = getDb();
  const row = await db.query.subdomainRequests.findFirst({ where: eq(subdomainRequests.id, requestId) });
  if (!row || !row.notificationEmail || !isValidNotificationEmail(row.notificationEmail)) return 'failed';
  if (row.requestEmailSentAt) return 'accepted';

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    await db.update(subdomainRequests).set({ requestEmailError: 'not_configured' })
      .where(and(eq(subdomainRequests.id, requestId), isNull(subdomainRequests.requestEmailSentAt)));
    return 'not_configured';
  }

  const now = Date.now();
  const [claimed] = await db.update(subdomainRequests).set({ requestEmailAttemptedAt: now, requestEmailError: null })
    .where(and(
      eq(subdomainRequests.id, requestId),
      isNull(subdomainRequests.requestEmailSentAt),
      or(isNull(subdomainRequests.requestEmailAttemptedAt), lt(subdomainRequests.requestEmailAttemptedAt, now - 60_000)),
    )).returning({ id: subdomainRequests.id });
  if (!claimed) return 'busy';

  // The public form must not be usable as an arbitrary email-spam relay.
  const limit = await enforceRegistryScopedRateLimit('request-received-email', row.notificationEmail, 5, 24 * 60 * 60_000);
  if (!limit.allowed) {
    await db.update(subdomainRequests).set({ requestEmailError: 'recipient_rate_limit' }).where(eq(subdomainRequests.id, requestId));
    return 'failed';
  }

  const parent = await db.query.managedDomains.findFirst({
    where: eq(managedDomains.id, row.parentDomainId),
    columns: { hostname: true },
  });
  if (!parent) {
    await db.update(subdomainRequests).set({ requestEmailError: 'parent_not_found' }).where(eq(subdomainRequests.id, requestId));
    return 'failed';
  }

  const result = await sendRequestReceivedEmail({
    requestId,
    email: row.notificationEmail,
    hostname: `${row.subdomain}.${parent.hostname}`,
    language: row.notificationLanguage,
    apiKey,
    from,
  });
  await db.update(subdomainRequests).set(result.accepted
    ? { requestEmailSentAt: Date.now(), requestEmailError: null }
    : { requestEmailError: result.error })
    .where(and(eq(subdomainRequests.id, requestId), eq(subdomainRequests.requestEmailAttemptedAt, now)));
  return result.accepted ? 'accepted' : 'failed';
}
