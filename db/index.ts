import { neon, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';

let ready: Promise<void> | undefined;
let pool: Pool | undefined;
export const SCHEMA_VERSION = 9;

/** One lightweight readiness read per process; migrations are never run here. */
export function ensureRegistrySchema() {
  return ready ??= getSql().query('SELECT version FROM registry_schema_version WHERE id = 1')
    .then((rows) => {
      if (!rows.length || Number(rows[0].version) < SCHEMA_VERSION) throw new Error('Database migration is required.');
    }).catch(() => { ready = undefined; throw new Error('Database is not ready. Run npm run db:migrate before deploying.'); });
}

export function getSql() { return neon(databaseUrl()); }
export function getDb() {
  pool ??= new Pool({ connectionString: databaseUrl(), max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
  return drizzle(pool, { schema });
}
function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || value === '[SENSITIVE]') throw new Error('DATABASE_URL is unavailable.');
  return value;
}
