import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { bootstrapLegacySchema } from '@/db/bootstrap';
import { beginDnsOperation, runDnsOperation } from '@/lib/dns-operations';
import { validateDnsRecord } from '@/lib/dns';

const state = vi.hoisted(() => ({ db: null as unknown, provider: new Map<string, { comment: string }>(), failAfterCreate: false, reject: false, createCalls: 0 }));
vi.mock('@/db', () => ({ getDb: () => state.db, ensureRegistrySchema: async () => {}, getSql: () => ({ query: async () => [] }) }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/telegram', () => ({ sendTelegramMessageToOwner: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ enforceRegistryScopedRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/cloudflare', () => {
  class CloudflareError extends Error { constructor(public definitive: boolean) { super('provider rejection'); } }
  return {
    CloudflareError,
    findCloudflareRecordByComment: async (_: string, __: unknown, comment: string) => [...state.provider].find(([, row]) => row.comment === comment)?.[0] ?? null,
    createCloudflareRecord: async (_: string, __: unknown, comment: string) => {
      if (state.reject) throw new CloudflareError(true);
      const id = crypto.randomUUID(); state.createCalls++; state.provider.set(id, { comment });
      if (state.failAfterCreate) { state.failAfterCreate = false; throw new Error('Connection lost after provider accepted'); }
      return id;
    },
    updateCloudflareRecord: async () => {},
    deleteCloudflareRecord: async (id: string) => { state.provider.delete(id); },
  };
});

const pg = new PGlite(), db = drizzle(pg, { schema });
function record(name = 'web') {
  const result = validateDnsRecord({ recordType: 'A', recordName: name, content: '203.0.113.10', ttl: 1, proxied: false });
  if ('error' in result) throw new Error(result.error);
  return result.value;
}
const operation = (kind: 'create' | 'release' | 'delete' | 'update' = 'create') => ({ id: crypto.randomUUID(), ownerId: 'owner', subdomainId: 'domain', kind });

beforeAll(async () => {
  state.db = db;
  await bootstrapLegacySchema({ query: (text, values) => pg.query(text, values) });
  await pg.exec(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await pg.exec('TRUNCATE notification_jobs, dns_events, dns_operations, dns_records, subdomains, owners, subdomain_requests CASCADE');
  state.provider.clear(); state.createCalls = 0; state.reject = false; state.failAfterCreate = false;
  process.env.DNS_RECORD_LIMIT = '50';
  await db.update(schema.managedDomains).set({ cloudflareZoneId: 'a'.repeat(32) }).where(eq(schema.managedDomains.id, schema.TAKESHI_DEV_MANAGED_DOMAIN_ID));
  await db.insert(schema.owners).values({ id: 'owner', email: '', createdAt: 1, updatedAt: 1 });
  await db.insert(schema.subdomains).values({ id: 'domain', label: 'test', ownerId: 'owner', createdAt: 1, updatedAt: 1 });
  await db.insert(schema.dnsRecords).values({ id: 'primary', subdomainId: 'domain', ...record('@'), isPrimary: true, cloudflareRecordId: 'provider-primary', createdAt: 1, updatedAt: 1 });
  state.provider.set('provider-primary', { comment: 'primary' });
});
afterAll(async () => { delete process.env.DNS_RECORD_LIMIT; await pg.close(); });

describe('durable DNS and migration invariants', () => {
  it('migration can be reapplied without destroying data', async () => {
    await bootstrapLegacySchema({ query: (text, values) => pg.query(text, values) });
    await pg.exec(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
    expect(await db.select().from(schema.subdomains)).toHaveLength(1);
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(1);
  });
  it('blocks writes belonging to another owner', async () => {
    await expect(beginDnsOperation({ ...operation(), ownerId: 'stranger', after: record() })).rejects.toMatchObject({ status: 404 });
    expect(state.createCalls).toBe(0);
  });
  it('enforces quota before calling Cloudflare', async () => {
    process.env.DNS_RECORD_LIMIT = '1';
    await expect(beginDnsOperation({ ...operation(), after: record() })).rejects.toMatchObject({ status: 409 });
    expect(state.createCalls).toBe(0);
  });
  it('cannot rename or delete the primary record through child APIs', async () => {
    await expect(beginDnsOperation({ ...operation('update'), recordId: 'primary', after: record('other') })).rejects.toMatchObject({ status: 400 });
    await expect(beginDnsOperation({ ...operation('delete'), recordId: 'primary' })).rejects.toMatchObject({ status: 409 });
  });
  it('replays one operation once and commits record + audit together', async () => {
    const args = { ...operation(), after: record() };
    await beginDnsOperation(args); expect(await runDnsOperation(args.id)).toEqual({ ok: true });
    await beginDnsOperation(args); expect(await runDnsOperation(args.id)).toEqual({ ok: true });
    expect(state.createCalls).toBe(1);
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(2);
    expect(await db.select().from(schema.dnsEvents)).toHaveLength(1);
    await expect(beginDnsOperation({ ...args, after: record('different') })).rejects.toMatchObject({ status: 409 });
  });
  it('recovers a provider success followed by network failure without duplication', async () => {
    const args = { ...operation(), after: record() };
    await beginDnsOperation(args); state.failAfterCreate = true;
    expect(await runDnsOperation(args.id)).toMatchObject({ pending: true });
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(1);
    await db.update(schema.dnsOperations).set({ leaseUntil: 0 }).where(eq(schema.dnsOperations.id, args.id));
    expect(await runDnsOperation(args.id)).toEqual({ ok: true });
    expect(state.createCalls).toBe(1);
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(2);
  });
  it('frees a failed claim only for a definitive provider rejection', async () => {
    const args = { ...operation(), after: record() }; await beginDnsOperation(args); state.reject = true;
    await expect(runDnsOperation(args.id)).rejects.toMatchObject({ status: 502 });
    expect((await db.select().from(schema.dnsOperations))[0].status).toBe('failed');
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(1);
    expect(await db.select().from(schema.dnsEvents)).toHaveLength(0);
  });
  it('freezes a releasing domain until all 50 records are deleted, retaining logs', async () => {
    for (let i = 0; i < 49; i++) {
      const id = `child-${i}`; state.provider.set(id, { comment: id });
      await db.insert(schema.dnsRecords).values({ id, subdomainId: 'domain', ...record(`web${i}`), cloudflareRecordId: id, createdAt: 1, updatedAt: 1 });
    }
    const args = operation('release'); await beginDnsOperation(args);
    await expect(beginDnsOperation({ ...operation(), after: record() })).rejects.toMatchObject({ status: 409 });
    for (let i = 0; i < 9; i++) expect(await runDnsOperation(args.id)).toMatchObject({ pending: true });
    expect(await runDnsOperation(args.id)).toMatchObject({ ownerDeleted: true });
    expect(state.provider.size).toBe(0);
    expect(await db.select().from(schema.subdomains)).toHaveLength(0);
    expect(await db.select().from(schema.dnsRecords)).toHaveLength(0);
    expect(await db.select().from(schema.dnsEvents)).toHaveLength(51);
  });
});
