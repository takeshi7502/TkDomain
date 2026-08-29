import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
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
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subdomain_requests (
      id TEXT PRIMARY KEY NOT NULL,
      subdomain TEXT NOT NULL,
      cname_target TEXT NOT NULL,
      github_handle TEXT,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      reviewer_note TEXT,
      cloudflare_record_id TEXT
    )`),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS subdomain_requests_subdomain_unique ON subdomain_requests (subdomain)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_status_created ON subdomain_requests (status, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subdomain_requests_email_created ON subdomain_requests (email, created_at)'),
    env.DB.prepare('PRAGMA optimize'),
  ]);
}

export function getDb() {
  if (!env.DB) {
    throw new Error(
      'Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database.',
    );
  }

  return drizzle(env.DB, { schema });
}
