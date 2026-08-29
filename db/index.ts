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
