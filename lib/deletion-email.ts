import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { managedDomains, subdomainRequests } from '@/db/schema';
import { sendDeletionEmail } from '@/lib/approval-email-message';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';
import { isValidNotificationEmail } from '@/lib/registry';

/** Invoked only through the leased outbox job created by an admin deletion. */
export async function notifyDeletedRequest(requestId: string, jobCreatedAt: number, previousAttempts: number) {
  const [row] = await getDb().select({ request: subdomainRequests, hostname: managedDomains.hostname })
    .from(subdomainRequests).innerJoin(managedDomains, eq(subdomainRequests.parentDomainId, managedDomains.id)).where(eq(subdomainRequests.id, requestId));
  if (!row || row.request.status !== 'released') return 'inactive';
  if (!row.request.notificationEmail || !isValidNotificationEmail(row.request.notificationEmail)) return 'not_requested';
  const apiKey = process.env.RESEND_API_KEY?.trim(), from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return 'not_configured';
  // Do not retry uncertain delivery past Resend's 24-hour deduplication window.
  if (previousAttempts > 0 && jobCreatedAt < Date.now() - 23 * 60 * 60_000) return 'manual_check';
  const budget = await enforceRegistryScopedRateLimit('deletion-email', row.request.notificationEmail, 8, 24 * 60 * 60_000);
  if (!budget.allowed) return 'failed';
  const result = await sendDeletionEmail({ requestId, email: row.request.notificationEmail,
    hostname: `${row.request.subdomain}.${row.hostname}`, language: row.request.notificationLanguage,
    reason: row.request.reviewerNote ?? '', apiKey, from });
  return result.accepted ? 'accepted' : 'failed';
}
