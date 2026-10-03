import { readFile } from 'node:fs/promises';
import { Pool } from '@neondatabase/serverless';
import { bootstrapLegacySchema } from '../db/bootstrap';

const url = process.env.DATABASE_URL_UNPOOLED;
if (!url || url.includes('[SENSITIVE]')) throw new Error('Set DATABASE_URL_UNPOOLED to the direct URL of the intended branch.');
if (new URL(url).hostname.includes('-pooler')) throw new Error('Migrations require a direct, non-pooled connection.');
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query('SELECT pg_advisory_xact_lock(74753609)');
  await client.query('CREATE TABLE IF NOT EXISTS registry_schema_version(id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  const { rows } = await client.query('SELECT version FROM registry_schema_version WHERE id = 1');
  if (Number(rows[0]?.version ?? 0) < 9) {
    await bootstrapLegacySchema(client);
    await client.query(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
    await client.query('INSERT INTO registry_schema_version VALUES(1,9) ON CONFLICT(id) DO UPDATE SET version = 9');
  }
  await client.query('COMMIT');
  console.log('Schema version 9 ready. No access keys or DNS provider records were changed.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration rolled back. Inspect the target branch before retrying.');
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  console.error('Database error code:', code);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
