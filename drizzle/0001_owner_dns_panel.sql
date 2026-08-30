CREATE TABLE IF NOT EXISTS "owners" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL UNIQUE,
  "github_handle" text,
  "access_key_hash" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS "subdomains" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL UNIQUE,
  "owner_id" text NOT NULL REFERENCES "owners"("id") ON DELETE RESTRICT,
  "status" text DEFAULT 'active' NOT NULL,
  "request_id" text REFERENCES "subdomain_requests"("id") ON DELETE SET NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS "dns_records" (
  "id" text PRIMARY KEY NOT NULL,
  "subdomain_id" text NOT NULL REFERENCES "subdomains"("id") ON DELETE CASCADE,
  "record_type" text NOT NULL,
  "record_name" text DEFAULT '@' NOT NULL,
  "content" text NOT NULL,
  "ttl" integer DEFAULT 1 NOT NULL,
  "proxied" boolean DEFAULT false NOT NULL,
  "priority" integer,
  "cloudflare_record_id" text NOT NULL UNIQUE,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  UNIQUE("subdomain_id", "record_type", "record_name", "content")
);
CREATE TABLE IF NOT EXISTS "owner_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "owners"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" bigint NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS "dns_events" (
  "id" text PRIMARY KEY NOT NULL,
  "subdomain_id" text NOT NULL REFERENCES "subdomains"("id") ON DELETE CASCADE,
  "record_id" text,
  "actor_type" text NOT NULL,
  "action" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_owners_access_key_hash" ON "owners" ("access_key_hash");
CREATE INDEX IF NOT EXISTS "idx_subdomains_owner_status" ON "subdomains" ("owner_id", "status");
CREATE INDEX IF NOT EXISTS "idx_dns_records_subdomain_name" ON "dns_records" ("subdomain_id", "record_name");
CREATE INDEX IF NOT EXISTS "idx_owner_sessions_owner_expiry" ON "owner_sessions" ("owner_id", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_dns_events_subdomain_created" ON "dns_events" ("subdomain_id", "created_at");
