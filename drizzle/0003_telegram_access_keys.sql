ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "telegram_username" text;
ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "requested_access_key_hash" text;
CREATE INDEX IF NOT EXISTS "idx_subdomain_requests_telegram_created" ON "subdomain_requests" ("telegram_username", "created_at");

ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "telegram_username" text;
CREATE INDEX IF NOT EXISTS "idx_owners_telegram_username" ON "owners" ("telegram_username");
