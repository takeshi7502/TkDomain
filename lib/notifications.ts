import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { managedDomains, notificationJobs, subdomainRequests } from '@/db/schema';
import { notifyApprovedRequest } from '@/lib/approval-email';
import { notifyRequestReceived } from '@/lib/request-email';
import { notifyAdminOfNewRequest } from '@/lib/telegram';

export function notificationValues(requestId: string, kinds: Array<typeof notificationJobs.$inferSelect.kind>) {
  const now = Date.now();
  return kinds.map((kind) => ({ id: crypto.randomUUID(), requestId, kind, nextAttemptAt: now, createdAt: now, updatedAt: now }));
}

/** Durable jobs contain request IDs, never plaintext access keys or bot secrets. */
export async function processNotifications(requestId?: string, limit = 3, deadline = Infinity) {
  const db = getDb(), now = Date.now();
  const jobs = await db.select().from(notificationJobs)
    .where(and(eq(notificationJobs.status, 'pending'), lt(notificationJobs.nextAttemptAt, now + 1), lt(notificationJobs.leaseUntil, now),
      ...(requestId ? [eq(notificationJobs.requestId, requestId)] : [])))
    .orderBy(asc(notificationJobs.createdAt)).limit(limit);
  let processed = 0;
  for (const job of jobs) {
    if (Date.now() > deadline - 25_000) break;
    const token = crypto.randomUUID();
    const [claimed] = await db.update(notificationJobs).set({ leaseToken: token, leaseUntil: Date.now() + 120_000, attempts: sql`${notificationJobs.attempts} + 1`, updatedAt: Date.now() })
      .where(and(eq(notificationJobs.id, job.id), eq(notificationJobs.status, 'pending'), lt(notificationJobs.leaseUntil, Date.now()))).returning();
    if (!claimed) continue;
    processed++;
    let result = 'failed';
    try {
      if (job.kind === 'receipt') result = await notifyRequestReceived(job.requestId);
      else if (job.kind === 'approval') result = await notifyApprovedRequest(job.requestId);
      else {
        const [row] = await db.select({ request: subdomainRequests, hostname: managedDomains.hostname }).from(subdomainRequests)
          .innerJoin(managedDomains, eq(subdomainRequests.parentDomainId, managedDomains.id)).where(eq(subdomainRequests.id, job.requestId));
        if (!row) result = 'inactive';
        else {
          const sent = await notifyAdminOfNewRequest({ requestId: row.request.id, hostname: `${row.request.subdomain}.${row.hostname}`, recordType: row.request.recordType, recordContent: row.request.cnameTarget, recordPriority: row.request.recordPriority, telegramUsername: row.request.telegramUsername ?? '' });
          result = sent.sent ? 'accepted' : sent.configured ? 'failed' : 'not_configured';
        }
      }
    } catch { console.warn('Notification retry deferred.'); }
    const done = ['accepted', 'not_requested', 'inactive', 'key_changed'].includes(result);
    const stopped = ['manual_check'].includes(result) || claimed.attempts >= 8;
    await db.update(notificationJobs).set({ status: done ? 'done' : stopped ? 'failed' : 'pending',
      leaseToken: null, leaseUntil: 0, updatedAt: Date.now(),
      nextAttemptAt: Date.now() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(claimed.attempts, 8)),
    }).where(and(eq(notificationJobs.id, job.id), eq(notificationJobs.leaseToken, token)));
  }
  return processed;
}

export async function retryNotification(requestId: string, kind: typeof notificationJobs.$inferSelect.kind) {
  await getDb().insert(notificationJobs).values(notificationValues(requestId, [kind]))
    .onConflictDoUpdate({ target: [notificationJobs.requestId, notificationJobs.kind], set: { status: 'pending', attempts: 0, nextAttemptAt: Date.now() } });
}

export async function notificationPendingCount() {
  const [row] = await getDb().select({ value: sql<number>`count(*)::integer` }).from(notificationJobs).where(inArray(notificationJobs.status, ['pending', 'failed']));
  return row.value;
}
