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
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    reviewed_at BIGINT,
    reviewer_note TEXT,
    cloudflare_record_id TEXT
  )`);
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS subdomain_requests_subdomain_unique ON subdomain_requests (subdomain)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_status_created ON subdomain_requests (status, created_at)');
  await sql.query('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_email_created ON subdomain_requests (email, created_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    github_handle TEXT,
    access_key_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_owners_access_key_hash ON owners (access_key_hash)');
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
    cloudflare_record_id TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (subdomain_id, record_type, record_name, content)
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_dns_records_subdomain_name ON dns_records (subdomain_id, record_name)');
  await sql.query(`CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner_expiry ON owner_sessions (owner_id, expires_at)');
  await sql.query(`CREATE TABLE IF NOT EXISTS dns_events (
    id TEXT PRIMARY KEY NOT NULL,
    subdomain_id TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
    record_id TEXT,
    actor_type TEXT NOT NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL
  )`);
  await sql.query('CREATE INDEX IF NOT EXISTS idx_dns_events_subdomain_created ON dns_events (subdomain_id, created_at)');

  // Bring already-approved CNAMEs into the owner panel without changing their DNS records.
  await sql.query(`INSERT INTO owners (id, email, github_handle, status, created_at, updated_at)
    SELECT 'legacy-owner-' || md5(email), email, github_handle, 'active', created_at, created_at
    FROM subdomain_requests
    WHERE status = 'active'
    ON CONFLICT (email) DO NOTHING`);
  await sql.query(`INSERT INTO subdomains (id, label, owner_id, status, request_id, created_at, updated_at)
    SELECT 'legacy-subdomain-' || r.id, r.subdomain, o.id, 'active', r.id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN owners o ON o.email = r.email
    WHERE r.status = 'active'
    ON CONFLICT (label) DO NOTHING`);
  await sql.query(`INSERT INTO dns_records (id, subdomain_id, record_type, record_name, content, ttl, proxied, cloudflare_record_id, created_at, updated_at)
    SELECT 'legacy-record-' || r.id, s.id, 'CNAME', '@', r.cname_target, 1, FALSE, r.cloudflare_record_id, r.created_at, r.reviewed_at
    FROM subdomain_requests r
    JOIN subdomains s ON s.label = r.subdomain
    WHERE r.status = 'active' AND r.cloudflare_record_id IS NOT NULL
    ON CONFLICT (cloudflare_record_id) DO NOTHING`);
}

function getSql() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is unavailable. Add the Neon connection string to Vercel Environment Variables before using the registry.');
  }
  return neon(databaseUrl);
}

export function getDb() {
  return drizzle(getSql(), { schema });
}
