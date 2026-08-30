ALTER TABLE "dns_records" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;
CREATE TABLE IF NOT EXISTS "registry_rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "window_start" bigint NOT NULL,
  "hits" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_registry_rate_limits_window_start" ON "registry_rate_limits" ("window_start");

UPDATE "dns_records" AS d
SET "is_primary" = true
FROM "subdomains" AS s
JOIN "subdomain_requests" AS r ON r."id" = s."request_id"
WHERE d."subdomain_id" = s."id"
  AND d."record_name" = '@'
  AND d."cloudflare_record_id" = r."cloudflare_record_id"
  AND d."is_primary" = false;
