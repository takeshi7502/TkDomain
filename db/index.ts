import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

let registrySchemaReady: Promise<void> | undefined;

export function ensureRegistrySchema() {
  if (!registrySchemaReady) {
    registrySchemaReady = createRegistrySchema().catch((error) => {
      registrySchemaReady = undefined;
      throw error;
    });
  }
  return registrySchemaReady;
}

async function createRegistrySchema() {
  const sql = getSql();
  await sql.query(`CREATE TABLE IF NOT EXISTS subdomain_requests (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain TEXT NOT NULL,
    cname_target TEXT NOT NULL,
    github_handle TEXT,
    email TEXT NOT NULL,
    telegram_username TEXT,
    requested_access_key_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    reviewed_at BIGINT,
    review_started_at BIGINT,
    cancelled_at BIGINT,
    released_at BIGINT,
    reviewer_note TEXT,
    cloudflare_record_id TEXT
  )`);
  // Keep every finished request as history, while keeping a name exclusive
  // during its pending/active lifecycle.
  await sql.query('DROP INDEX IF EXISTS subdomain_requests_subdomain_unique');
  await sql.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_subdomain_requests_open_subdomain ON subdomain_requests (subdomain) WHERE status IN ('pending', 'active')");
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_status_created ON subdomain_requests (status, created_at)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_email_created ON subdomain_requests (email, created_at)');
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS telegram_username TEXT');
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS requested_access_key_hash TEXT');
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS review_started_at BIGINT');
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS cancelled_at BIGINT');
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS released_at BIGINT');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_telegram_created ON subdomain_requests (telegram_username, created_at)');
  await sql.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_subdomain_requests_pending_access_key_unique ON subdomain_requests (requested_access_key_hash) WHERE status = 'pending' AND requested_access_key_hash IS NOT NULL");
  await sql.query(`CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    github_handle TEXT,
    telegram_username TEXT,
    access_key_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_owners_access_key_hash ON owners (access_key_hash)');
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_access_key_hash_unique ON owners (access_key_hash) WHERE access_key_hash IS NOT NULL');
  await sql.query('ALTER TABLE owners ADD COLUMN IF NOT EXISTS telegram_username TEXT');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_owners_telegram_username ON owners (telegram_username)');
  await sql.query(`CREATE TABLE IF NOT EXISTS subdomains (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active',
    request_id TEXT REFERENCES subdomain_requests(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomains_owner_status ON subdomains (owner_id, status)');
  await sql.query(`CREATE TABLE IF NOT EXISTS dns_records (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain_id TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
    record_type TEXT NOT NULL,
    record_name TEXT NOT NULL DEFAULT '@',
    content TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 1,
    proxied BOOLEAN NOT NULL DEFAULT FALSE,
    priority INTEGER,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    cloudflare_record_id TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (subdomain_id, record_type, record_name, content)
  )`);
  await sql.query('ALTER TABLE dns_records ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_dns_records_subdomain_name ON dns_records (subdomain_id, record_name)');
  await sql.query(`CREATE TABLE IF NOT EXISTS registry_rate_limits (
    key TEXT PRIMARY KEY NOT NULL,
    window_start BIGINT NOT NULL,
    hits INTEGER NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_registry_rate_limits_window_start ON registry_rate_limits (window_start)');
  await sql.query(`CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner_expiry ON owner_sessions (owner_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS pending_request_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL REFERENCES subdomain_requests(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_pending_request_sessions_request_expiry ON pending_request_sessions (request_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS dns_events (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain_id TEXT REFERENCES subdomains(id) ON DELETE SET NULL,
    domain_label TEXT,
    record_id TEXT,
    actor_type TEXT NOT NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('ALTER TABLE dns_events ADD COLUMN IF NOT EXISTS domain_label TEXT');
  await sql.query('ALTER TABLE dns_events ALTER COLUMN subdomain_id DROP NOT NULL');
  await sql.query(`UPDATE dns_events AS event
    SET domain_label = subdomain.label
    FROM subdomains AS subdomain
    WHERE event.subdomain_id = subdomain.id
      AND event.domain_label IS NULL`);
  await sql.query(`DO $$
  DECLARE old_constraint TEXT;
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
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'dns_events'::regclass
        AND contype = 'f'
        AND confrelid = 'subdomains'::regclass
        AND confdeltype = 'n'
    ) THEN
      ALTER TABLE dns_events
        ADD CONSTRAINT dns_events_subdomain_id_fkey
        FOREIGN KEY (subdomain_id) REFERENCES subdomains(id) ON DELETE SET NULL;
    END IF;
  END $$`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_dns_events_subdomain_created ON dns_events (subdomain_id, created_at)');

  // Bring already-approved CNAMEs into the owner panel without changing their DNS records.
  await sql.query(`INSERT INTO owners (id, email, github_handle, status, created_at, updated_at)
    SELECT 'legacy-owner-' || md5(email), email, github_handle, 'active', created_at, created_at
    FROM subdomain_requests
    WHERE status = 'active' AND telegram_username IS NULL
    ON CONFLICT (email) DO NOTHING`);
  await sql.query(`INSERT INTO subdomains (id, label, owner_id, status, request_id, created_at, updated_at)
    SELECT 'legacy-subdomain-' || r.id, r.subdomain, o.id, 'active', r.id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN owners o ON o.email = r.email
    WHERE r.status = 'active' AND r.telegram_username IS NULL
    ON CONFLICT (label) DO NOTHING`);
  await sql.query(`INSERT INTO dns_records (id, subdomain_id, record_type, record_name, content, ttl, proxied, cloudflare_record_id, created_at, updated_at)
    SELECT 'legacy-record-' || r.id, s.id, 'CNAME', '@', r.cname_target, 1, FALSE, r.cloudflare_record_id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN subdomains s ON s.label = r.subdomain
    WHERE r.status = 'active' AND r.cloudflare_record_id IS NOT NULL
    ON CONFLICT (cloudflare_record_id) DO NOTHING`);
  await sql.query(`UPDATE dns_records d
    SET is_primary = TRUE
    FROM subdomains s
    JOIN subdomain_requests r ON r.id = s.request_id
    WHERE d.subdomain_id = s.id
      AND d.record_name = '@'
      AND d.cloudflare_record_id = r.cloudflare_record_id
      AND d.is_primary = FALSE`);
}

export function getSql() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is unavailable. Add the Neon connection string to Vercel Environment Variables before using the registry.');
  }
  return neon(databaseUrl);
}

export function getDb() {
  return drizzle(getSql(), { schema });
}
