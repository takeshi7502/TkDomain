-- Multiple registry parents share the same application and access-key model.
-- The original takeshi.dev data is retained by assigning it to this stable
-- parent row before any uniqueness constraint is widened.
CREATE TABLE IF NOT EXISTS "managed_domains" (
  "id" text PRIMARY KEY NOT NULL,
  "hostname" text NOT NULL UNIQUE,
  "cloudflare_zone_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_managed_domains_status_hostname"
  ON "managed_domains" ("status", "hostname");

INSERT INTO "managed_domains" ("id", "hostname", "cloudflare_zone_id", "status", "created_at", "updated_at")
VALUES (
  'managed-domain-takeshi-dev',
  'takeshi.dev',
  NULL,
  'active',
  (FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000))::bigint,
  (FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000))::bigint
)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "subdomain_requests" ADD COLUMN IF NOT EXISTS "parent_domain_id" text;
UPDATE "subdomain_requests"
SET "parent_domain_id" = 'managed-domain-takeshi-dev'
WHERE "parent_domain_id" IS NULL;
ALTER TABLE "subdomain_requests"
  ALTER COLUMN "parent_domain_id" SET DEFAULT 'managed-domain-takeshi-dev';
ALTER TABLE "subdomain_requests"
  ALTER COLUMN "parent_domain_id" SET NOT NULL;

ALTER TABLE "subdomains" ADD COLUMN IF NOT EXISTS "parent_domain_id" text;
UPDATE "subdomains"
SET "parent_domain_id" = 'managed-domain-takeshi-dev'
WHERE "parent_domain_id" IS NULL;
ALTER TABLE "subdomains"
  ALTER COLUMN "parent_domain_id" SET DEFAULT 'managed-domain-takeshi-dev';
ALTER TABLE "subdomains"
  ALTER COLUMN "parent_domain_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'subdomain_requests'::regclass
      AND conname = 'subdomain_requests_parent_domain_id_fkey'
  ) THEN
    ALTER TABLE "subdomain_requests"
      ADD CONSTRAINT "subdomain_requests_parent_domain_id_fkey"
      FOREIGN KEY ("parent_domain_id") REFERENCES "managed_domains"("id") ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'subdomains'::regclass
      AND conname = 'subdomains_parent_domain_id_fkey'
  ) THEN
    ALTER TABLE "subdomains"
      ADD CONSTRAINT "subdomains_parent_domain_id_fkey"
      FOREIGN KEY ("parent_domain_id") REFERENCES "managed_domains"("id") ON DELETE RESTRICT;
  END IF;
END $$;

-- A name is only exclusive inside its selected parent domain.
DROP INDEX IF EXISTS "subdomain_requests_subdomain_unique";
DROP INDEX IF EXISTS "idx_subdomain_requests_open_subdomain";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subdomain_requests_open_parent_subdomain"
  ON "subdomain_requests" ("parent_domain_id", "subdomain")
  WHERE "status" IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS "idx_subdomain_requests_parent_status_created"
  ON "subdomain_requests" ("parent_domain_id", "status", "created_at");

-- Remove the old global `subdomains.label` unique constraint only. Other
-- unique constraints, including DNS-record identity, are intentionally kept.
DO $$
DECLARE old_constraint text;
BEGIN
  FOR old_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'subdomains'::regclass
      AND con.contype = 'u'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'subdomains'::regclass
          AND attname = 'label'
          AND NOT attisdropped
      )
  LOOP
    EXECUTE format('ALTER TABLE subdomains DROP CONSTRAINT %I', old_constraint);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subdomains_parent_label_unique"
  ON "subdomains" ("parent_domain_id", "label");
CREATE INDEX IF NOT EXISTS "idx_subdomains_parent_owner_status"
  ON "subdomains" ("parent_domain_id", "owner_id", "status");

-- Events outlive both the subdomain and any future archival of its parent
-- configuration, so retain the parent hostname as an immutable audit field.
ALTER TABLE "dns_events" ADD COLUMN IF NOT EXISTS "parent_domain" text;
UPDATE "dns_events"
SET "parent_domain" = 'takeshi.dev'
WHERE "parent_domain" IS NULL OR "parent_domain" = '';
ALTER TABLE "dns_events"
  ALTER COLUMN "parent_domain" SET DEFAULT 'takeshi.dev';
ALTER TABLE "dns_events"
  ALTER COLUMN "parent_domain" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_dns_events_parent_domain_created"
  ON "dns_events" ("parent_domain", "created_at");
