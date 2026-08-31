import { neon, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';
import { TAKESHI_DEV_HOSTNAME, TAKESHI_DEV_MANAGED_DOMAIN_ID } from './schema';

let registrySchemaReady: Promise<void> | undefined;
let databasePool: Pool | undefined;

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
  const now = Date.now();
  const legacyZoneId = process.env.CLOUDFLARE_ZONE_ID?.trim() || null;

  // Parent domains are configuration rows, not environment-specific branches
  // of the schema. The original takeshi.dev zone is seeded deterministically
  // so every existing request/subdomain can be migrated without a data copy.
  await sql.query(`CREATE TABLE IF NOT EXISTS managed_domains (
    id TEXT PRIMARY KEY NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    cloudflare_zone_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_managed_domains_status_hostname ON managed_domains (status, hostname)');
  await sql.query(
    `INSERT INTO managed_domains (id, hostname, cloudflare_zone_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $4)
     ON CONFLICT (id) DO UPDATE SET
       cloudflare_zone_id = COALESCE(managed_domains.cloudflare_zone_id, EXCLUDED.cloudflare_zone_id),
       updated_at = CASE
         WHEN managed_domains.cloudflare_zone_id IS NULL AND EXCLUDED.cloudflare_zone_id IS NOT NULL
           THEN EXCLUDED.updated_at
         ELSE managed_domains.updated_at
       END`,
    [TAKESHI_DEV_MANAGED_DOMAIN_ID, TAKESHI_DEV_HOSTNAME, legacyZoneId, now],
  );

  await sql.query(`CREATE TABLE IF NOT EXISTS subdomain_requests (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain TEXT NOT NULL,
    parent_domain_id TEXT NOT NULL DEFAULT '${TAKESHI_DEV_MANAGED_DOMAIN_ID}' REFERENCES managed_domains(id) ON DELETE RESTRICT,
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
  await sql.query('ALTER TABLE subdomain_requests ADD COLUMN IF NOT EXISTS parent_domain_id TEXT');
  await sql.query('UPDATE subdomain_requests SET parent_domain_id = $1 WHERE parent_domain_id IS NULL', [TAKESHI_DEV_MANAGED_DOMAIN_ID]);
  await sql.query(`ALTER TABLE subdomain_requests
    ALTER COLUMN parent_domain_id SET DEFAULT '${TAKESHI_DEV_MANAGED_DOMAIN_ID}'`);
  await sql.query('ALTER TABLE subdomain_requests ALTER COLUMN parent_domain_id SET NOT NULL');
  await sql.query(`DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'subdomain_requests'::regclass
        AND conname = 'subdomain_requests_parent_domain_id_fkey'
    ) THEN
      ALTER TABLE subdomain_requests
        ADD CONSTRAINT subdomain_requests_parent_domain_id_fkey
        FOREIGN KEY (parent_domain_id) REFERENCES managed_domains(id) ON DELETE RESTRICT;
    END IF;
  END $$`);
  // Keep every finished request as history, while keeping a name exclusive
  // only inside its managed parent domain during the pending/active lifecycle.
  await sql.query('DROP INDEX IF EXISTS subdomain_requests_subdomain_unique');
  await sql.query('DROP INDEX IF EXISTS idx_subdomain_requests_open_subdomain');
  await sql.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_subdomain_requests_open_parent_subdomain ON subdomain_requests (parent_domain_id, subdomain) WHERE status IN ('pending', 'active')");
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_parent_status_created ON subdomain_requests (parent_domain_id, status, created_at)');
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
    label TEXT NOT NULL,
    parent_domain_id TEXT NOT NULL DEFAULT '${TAKESHI_DEV_MANAGED_DOMAIN_ID}' REFERENCES managed_domains(id) ON DELETE RESTRICT,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active',
    request_id TEXT REFERENCES subdomain_requests(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await sql.query('ALTER TABLE subdomains ADD COLUMN IF NOT EXISTS parent_domain_id TEXT');
  await sql.query('UPDATE subdomains SET parent_domain_id = $1 WHERE parent_domain_id IS NULL', [TAKESHI_DEV_MANAGED_DOMAIN_ID]);
  await sql.query(`ALTER TABLE subdomains
    ALTER COLUMN parent_domain_id SET DEFAULT '${TAKESHI_DEV_MANAGED_DOMAIN_ID}'`);
  await sql.query('ALTER TABLE subdomains ALTER COLUMN parent_domain_id SET NOT NULL');
  await sql.query(`DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'subdomains'::regclass
        AND conname = 'subdomains_parent_domain_id_fkey'
    ) THEN
      ALTER TABLE subdomains
        ADD CONSTRAINT subdomains_parent_domain_id_fkey
        FOREIGN KEY (parent_domain_id) REFERENCES managed_domains(id) ON DELETE RESTRICT;
    END IF;
  END $$`);
  // The original schema made `label` globally unique. Remove only that
  // single-column constraint; the new compound index below allows the same
  // label under separate admin-managed parents.
  await sql.query(`DO $$
  DECLARE old_constraint TEXT;
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
  END $$`);
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_subdomains_parent_label_unique ON subdomains (parent_domain_id, label)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomains_parent_owner_status ON subdomains (parent_domain_id, owner_id, status)');
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
  await sql.query(`CREATE TABLE IF NOT EXISTS telegram_links (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    telegram_user_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL UNIQUE,
    linked_username TEXT,
    display_name TEXT,
    linked_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (owner_id)
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_links_linked_username ON telegram_links (linked_username)');
  await sql.query(`CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    consumed_at BIGINT,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_owner_expiry ON telegram_link_tokens (owner_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS telegram_verification_challenges (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    telegram_link_id TEXT NOT NULL REFERENCES telegram_links(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    subject TEXT,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    consumed_at BIGINT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_verification_owner_purpose ON telegram_verification_challenges (owner_id, purpose, expires_at)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_verification_link_expiry ON telegram_verification_challenges (telegram_link_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS telegram_recovery_grants (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    telegram_link_id TEXT NOT NULL REFERENCES telegram_links(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    consumed_at BIGINT,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_recovery_grants_owner_expiry ON telegram_recovery_grants (owner_id, expires_at)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_recovery_grants_link_expiry ON telegram_recovery_grants (telegram_link_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
    update_id TEXT PRIMARY KEY NOT NULL,
    processed_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_telegram_webhook_updates_processed ON telegram_webhook_updates (processed_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS dns_events (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain_id TEXT REFERENCES subdomains(id) ON DELETE SET NULL,
    domain_label TEXT,
    parent_domain TEXT NOT NULL DEFAULT '${TAKESHI_DEV_HOSTNAME}',
    record_id TEXT,
    actor_type TEXT NOT NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('ALTER TABLE dns_events ADD COLUMN IF NOT EXISTS domain_label TEXT');
  await sql.query('ALTER TABLE dns_events ADD COLUMN IF NOT EXISTS parent_domain TEXT');
  await sql.query('UPDATE dns_events SET parent_domain = $1 WHERE parent_domain IS NULL OR parent_domain = \'\'', [TAKESHI_DEV_HOSTNAME]);
  await sql.query(`ALTER TABLE dns_events
    ALTER COLUMN parent_domain SET DEFAULT '${TAKESHI_DEV_HOSTNAME}'`);
  await sql.query('ALTER TABLE dns_events ALTER COLUMN parent_domain SET NOT NULL');
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
  await sql.query('CREATE INDEX IF NOT EXISTS idx_dns_events_parent_domain_created ON dns_events (parent_domain, created_at)');

  // Bring already-approved CNAMEs into the owner panel without changing their DNS records.
  await sql.query(`INSERT INTO owners (id, email, github_handle, status, created_at, updated_at)
    SELECT 'legacy-owner-' || md5(email), email, github_handle, 'active', created_at, created_at
    FROM subdomain_requests
    WHERE status = 'active' AND telegram_username IS NULL
    ON CONFLICT (email) DO NOTHING`);
  await sql.query(`INSERT INTO subdomains (id, label, parent_domain_id, owner_id, status, request_id, created_at, updated_at)
    SELECT 'legacy-subdomain-' || r.id, r.subdomain, r.parent_domain_id, o.id, 'active', r.id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN owners o ON o.email = r.email
    WHERE r.status = 'active' AND r.telegram_username IS NULL
    ON CONFLICT (parent_domain_id, label) DO NOTHING`);
  await sql.query(`INSERT INTO dns_records (id, subdomain_id, record_type, record_name, content, ttl, proxied, cloudflare_record_id, created_at, updated_at)
    SELECT 'legacy-record-' || r.id, s.id, 'CNAME', '@', r.cname_target, 1, FALSE, r.cloudflare_record_id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN subdomains s ON s.label = r.subdomain AND s.parent_domain_id = r.parent_domain_id
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
  return neon(getDatabaseUrl());
}

export function getDb() {
  return drizzle(getDatabasePool(), { schema });
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is unavailable. Add the Neon connection string to Vercel Environment Variables before using the registry.');
  }
  return databaseUrl;
}

function getDatabasePool() {
  if (!databasePool) databasePool = new Pool({ connectionString: getDatabaseUrl() });
  return databasePool;
}
