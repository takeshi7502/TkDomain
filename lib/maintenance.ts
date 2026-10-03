import { getSql } from '@/db';
import { resumeDnsOperations } from '@/lib/dns-operations';
import { processNotifications } from '@/lib/notifications';

/** Bounded housekeeping. Registration/DNS history is deliberately retained. */
export async function runMaintenance(retryStalled = false) {
  const sql = getSql(), now = Date.now();
  const deadline = now + 95_000;
  // Do not free pending names automatically: a review may have an uncertain
  // provider outcome, which must be reconciled instead of abandoned.
  // Names below are constants, not input from an API caller.
  for (const table of ['owner_sessions', 'pending_request_sessions', 'telegram_link_tokens', 'telegram_verification_challenges', 'telegram_recovery_grants']) {
    await sql.query(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expires_at < $1 ORDER BY expires_at LIMIT 500)`, [now]);
  }
  await sql.query('DELETE FROM registry_rate_limits WHERE key IN (SELECT key FROM registry_rate_limits WHERE window_start < $1 ORDER BY window_start LIMIT 500)', [now - 2 * 86400000]);
  await sql.query("DELETE FROM telegram_webhook_updates WHERE update_id IN (SELECT update_id FROM telegram_webhook_updates WHERE status = 'done' AND processed_at < $1 ORDER BY processed_at LIMIT 500)", [now - 30 * 86400000]);
  await sql.query("DELETE FROM dns_operations WHERE id IN (SELECT id FROM dns_operations WHERE status IN ('done','failed') AND updated_at < $1 ORDER BY updated_at LIMIT 1000)", [now - 30 * 86400000]);
  await sql.query("DELETE FROM notification_jobs WHERE id IN (SELECT id FROM notification_jobs WHERE status = 'done' AND updated_at < $1 ORDER BY updated_at LIMIT 500)", [now - 30 * 86400000]);
  if (retryStalled) await sql.query("UPDATE dns_operations SET attempts = 0 WHERE id IN (SELECT id FROM dns_operations WHERE status = 'pending' AND attempts >= 8 AND lease_until < $1 ORDER BY created_at LIMIT 10)", [now]);
  const dns = await resumeDnsOperations(undefined, 2, deadline);
  const notifications = await processNotifications(undefined, 3, deadline);
  const [pending] = await sql.query("SELECT (SELECT count(*)::int FROM dns_operations WHERE status='pending') AS dns, (SELECT count(*)::int FROM notification_jobs WHERE status='pending') AS notifications");
  return { ok: true, dns, notifications, pending };
}
