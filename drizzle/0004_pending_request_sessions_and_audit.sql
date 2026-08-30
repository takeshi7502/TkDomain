-- Preserve completed requests as history while reserving only pending/active names.
DROP INDEX IF EXISTS "subdomain_requests_subdomain_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subdomain_requests_open_subdomain"
  ON "subdomain_requests" ("subdomain")
  WHERE "status" IN ('pending', 'active');
ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "review_started_at" bigint;
ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "cancelled_at" bigint;
ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "released_at" bigint;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subdomain_requests_pending_access_key_unique"
  ON "subdomain_requests" ("requested_access_key_hash")
  WHERE "status" = 'pending' AND "requested_access_key_hash" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_owners_access_key_hash_unique"
  ON "owners" ("access_key_hash")
  WHERE "access_key_hash" IS NOT NULL;

-- A pending claimant receives a short-lived, HTTP-only session that cannot
-- access DNS APIs. It only powers the approval-status/cancel screen.
CREATE TABLE IF NOT EXISTS "pending_request_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL REFERENCES "subdomain_requests"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" bigint NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_pending_request_sessions_request_expiry"
  ON "pending_request_sessions" ("request_id", "expires_at");

-- DNS events are audit records: retain them even after a primary subdomain is
-- deleted, and save the label needed to display a deleted domain later.
ALTER TABLE "dns_events" ADD COLUMN IF NOT EXISTS "domain_label" text;
ALTER TABLE "dns_events" ALTER COLUMN "subdomain_id" DROP NOT NULL;
UPDATE "dns_events" AS event
SET "domain_label" = subdomain."label"
FROM "subdomains" AS subdomain
WHERE event."subdomain_id" = subdomain."id"
  AND event."domain_label" IS NULL;

DO $$
DECLARE old_constraint text;
BEGIN
  SELECT conname INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'dns_events'::regclass
    AND contype = 'f'
    AND confrelid = 'subdomains'::regclass
    AND confdeltype <> 'n'
  LIMIT 1;

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE dns_events DROP CONSTRAINT %I', old_constraint);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dns_events'::regclass
      AND contype = 'f'
      AND confrelid = 'subdomains'::regclass
      AND confdeltype = 'n'
  ) THEN
    ALTER TABLE "dns_events"
      ADD CONSTRAINT "dns_events_subdomain_id_fkey"
      FOREIGN KEY ("subdomain_id") REFERENCES "subdomains"("id") ON DELETE SET NULL;
  END IF;
END $$;
