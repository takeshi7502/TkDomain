import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from '@neondatabase/serverless';

// Deliberately bound to the disposable branch observed in Neon Console.
// Never run these synthetic writes against the production endpoint.
const SOURCE = 'ep-curly-resonance-azjrm4sa.c-3.ap-southeast-1.aws.neon.tech';
const TARGET = 'ep-wandering-hat-azs1n8c0.c-3.ap-southeast-1.aws.neon.tech';
const direct = new URL(process.env.DATABASE_URL_UNPOOLED!);
assert.equal(direct.hostname, SOURCE, 'Unexpected production source');
direct.hostname = TARGET;
process.env.DATABASE_URL_UNPOOLED = direct.toString();
const pooled = new URL(direct);
pooled.hostname = TARGET.replace('.c-3.', '-pooler.c-3.');
process.env.DATABASE_URL = pooled.toString();
process.env.REGISTRY_AUTH_SECRET = randomUUID();
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RESEND_API_KEY;
assert.notEqual(new URL(process.env.DATABASE_URL).hostname, SOURCE);

const pool = new Pool({ connectionString: direct.toString(), max: 4, connectionTimeoutMillis: 10_000 });
const prefix = `stability-test-${randomUUID()}`;
const parentId = `${prefix}-parent`, ownerId = `${prefix}-owner`, domainId = `${prefix}-domain`;
const tables = ['managed_domains', 'subdomain_requests', 'owners', 'subdomains', 'dns_records', 'dns_events', 'owner_sessions', 'pending_request_sessions', 'telegram_links', 'telegram_link_tokens', 'telegram_verification_challenges', 'telegram_recovery_grants'];
async function snapshot() {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    result[table] = { count: rows.length, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  const { rows } = await pool.query('SELECT update_id, processed_at FROM telegram_webhook_updates ORDER BY update_id');
  result.telegram_webhook_updates = { count: rows.length, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  return result;
}
try {
  const before = await snapshot();
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { env: process.env, stdio: 'inherit' });
  assert.deepEqual(await snapshot(), before, 'Migration changed existing registry/auth/DNS data');
  const { rows: violations } = await pool.query(`SELECT
    (SELECT count(*) FROM subdomains s LEFT JOIN owners o ON o.id=s.owner_id WHERE o.id IS NULL)::int orphan_owners,
    (SELECT count(*) FROM (SELECT subdomain_id FROM dns_records WHERE is_primary GROUP BY subdomain_id HAVING count(*)>1) d)::int duplicate_primary`);
  assert.deepEqual(violations[0], { orphan_owners: 0, duplicate_primary: 0 });
  console.log('Two migrations preserved all existing rows, key hashes, Telegram links and provider IDs.');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(before).map(([name, value]) => [name, value.count]))));

  const now = Date.now();
  await pool.query('INSERT INTO managed_domains(id,hostname,cloudflare_zone_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [parentId, `${prefix}.invalid`, 'a'.repeat(32), now]);
  await pool.query('INSERT INTO owners(id,email,created_at,updated_at) VALUES($1,$2,$3,$3)', [ownerId, `${prefix}@example.invalid`, now]);
  await pool.query('INSERT INTO subdomains(id,label,parent_domain_id,owner_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [domainId, 'test', parentId, ownerId, now]);
  await pool.query("INSERT INTO dns_records(id,subdomain_id,record_type,record_name,content,is_primary,cloudflare_record_id,created_at,updated_at) VALUES($1,$2,'A','@','203.0.113.10',true,$3,$4,$4)", [`${prefix}-record`, domainId, `${prefix}-provider`, now]);
  const { beginDnsOperation } = await import('../lib/dns-operations');
  const { validateDnsRecord } = await import('../lib/dns');
  const record = validateDnsRecord({ recordType: 'A', recordName: 'web', content: '203.0.113.20', ttl: 1, proxied: false });
  if ('error' in record) throw new Error(record.error);
  const args = { id: randomUUID(), ownerId, subdomainId: domainId, kind: 'create' as const, after: record.value };
  const racing = await Promise.allSettled([beginDnsOperation(args), beginDnsOperation({ ...args, id: randomUUID() })]);
  assert.equal(racing.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = racing.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  const { rows: operations } = await pool.query('SELECT id FROM dns_operations WHERE subdomain_id=$1', [domainId]);
  assert.equal(operations.length, 1);
  await Promise.all(Array.from({ length: 8 }, () => beginDnsOperation({ ...args, id: operations[0].id })));
  assert.equal((await pool.query('SELECT id FROM dns_operations WHERE subdomain_id=$1', [domainId])).rows.length, 1);
  console.log('Concurrent DNS claims serialize; repeated operation IDs create only one journal row.');
  await pool.query("UPDATE dns_operations SET status='failed' WHERE subdomain_id=$1", [domainId]);
  await beginDnsOperation({ id: randomUUID(), ownerId, subdomainId: domainId, kind: 'release' });
  await assert.rejects(beginDnsOperation({ ...args, id: randomUUID() }), (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409));
  assert.equal((await pool.query('SELECT status FROM subdomains WHERE id=$1', [domainId])).rows[0].status, 'deleting');
  console.log('Releasing domains reject concurrent new records. No Cloudflare or messaging API was called.');

  const { enforceRegistryScopedRateLimit } = await import('../lib/rate-limit');
  const limits = await Promise.all(Array.from({ length: 20 }, () => enforceRegistryScopedRateLimit('stability-branch-test', prefix, 3, 60_000)));
  assert.equal(limits.filter((r) => r.allowed).length, 3);
  console.log('Twenty concurrent rate-limit attempts allow exactly three.');
} finally {
  await pool.query('DELETE FROM dns_operations WHERE subdomain_id=$1', [domainId]);
  await pool.query('DELETE FROM subdomains WHERE id=$1', [domainId]);
  await pool.query('DELETE FROM owners WHERE id=$1', [ownerId]);
  await pool.query('DELETE FROM managed_domains WHERE id=$1', [parentId]);
  await pool.end();
}
