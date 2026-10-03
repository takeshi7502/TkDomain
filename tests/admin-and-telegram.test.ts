import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { bootstrapLegacySchema } from '@/db/bootstrap';
import { GET } from '@/app/api/admin/requests/route';
import { claimTelegramWebhookUpdate, completeTelegramWebhookUpdate, consumeTelegramLinkToken, createTelegramLinkToken } from '@/lib/telegram';

const state = vi.hoisted(() => ({ db: null as unknown, query: null as unknown }));
vi.mock('@/db', () => ({ getDb: () => state.db, ensureRegistrySchema: async () => {}, getSql: () => ({ query: state.query }) }));
vi.mock('@/lib/admin-auth', () => ({ isAdminAuthorized: () => true }));
vi.mock('next/server', async (importOriginal) => ({ ...await importOriginal<typeof import('next/server')>(), after: () => {} }));
const pg = new PGlite(), db = drizzle(pg, { schema });

beforeAll(async () => {
  state.db = db; state.query = async (text: string, values: unknown[]) => (await pg.query(text, values)).rows;
  process.env.REGISTRY_ADMIN_KEY = 'unit-test-only-root-secret';
  await bootstrapLegacySchema({ query: (text, values) => pg.query(text, values) });
  await pg.exec(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
});
afterAll(async () => { delete process.env.REGISTRY_ADMIN_KEY; await pg.close(); });

describe('admin bounded queries and Telegram replay safety', () => {
  it('finds an old pending request even behind 600 newer history items', async () => {
    await db.insert(schema.subdomainRequests).values([
      { id: 'old-pending', subdomain: 'pending', cnameTarget: 'example.com', email: '', createdAt: 1, requestedAccessKeyHash: 'private-hash' },
      ...Array.from({ length: 600 }, (_, i) => ({ id: `history-${i}`, subdomain: `old${i}`, cnameTarget: 'example.com', email: '', status: 'rejected' as const, createdAt: i + 2 })),
    ]);
    const pending = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests?tab=pending-requests'))).json();
    expect(pending.requests.map((r: { id: string }) => r.id)).toEqual(['old-pending']);
    expect(pending.requests[0]).not.toHaveProperty('requestedAccessKeyHash');
    const first = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests?tab=request-log'))).json();
    expect(first.requests).toHaveLength(50); expect(first.hasMore).toBe(true);
    const last = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests?tab=request-log&page=12'))).json();
    expect(last.requests).toHaveLength(1); expect(last.hasMore).toBe(false);
  });
  it('does not fetch private records until a domain is expanded', async () => {
    await db.insert(schema.owners).values({ id: 'owner', email: '', createdAt: 1, updatedAt: 1 });
    await db.insert(schema.subdomains).values({ id: 'domain', label: 'test', ownerId: 'owner', createdAt: 1, updatedAt: 1 });
    await db.insert(schema.dnsRecords).values({ id: 'record', subdomainId: 'domain', recordType: 'TXT', recordName: 'secret', content: 'verification=value', cloudflareRecordId: 'provider-private-id', createdAt: 1, updatedAt: 1 });
    const list = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests'))).json();
    expect(list.activeSubdomains[0].records).toBeUndefined();
    expect(list.activeSubdomains[0].recordCount).toBe(1);
    const detail = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests?subdomainId=domain'))).json();
    expect(detail.records[0].content).toBe('verification=value');
    expect(detail.records[0]).not.toHaveProperty('cloudflareRecordId');
    const domains = await (await GET(new NextRequest('https://domain.takeshi.dev/api/admin/requests?tab=domains'))).json();
    expect(domains.domains[0].activeCount).toBe(1);
    expect(domains.domains[0].pendingCount).toBe(1);
  });
  it('atomically claims duplicate webhook IDs and completes only its lease', async () => {
    const first = await claimTelegramWebhookUpdate('101'); expect(first.status).toBe('claimed');
    expect((await claimTelegramWebhookUpdate('101')).status).toBe('busy');
    await completeTelegramWebhookUpdate('101', 'wrong-lease');
    expect((await claimTelegramWebhookUpdate('101')).status).toBe('busy');
    await completeTelegramWebhookUpdate('101', first.leaseToken!);
    expect((await claimTelegramWebhookUpdate('101')).status).toBe('done');
  });
  it('commits a link and its completed webhook in the same transaction', async () => {
    const token = await createTelegramLinkToken('owner'); if (token.status !== 'created') throw new Error('No token');
    const claimed = await claimTelegramWebhookUpdate('102');
    const result = await consumeTelegramLinkToken(token.token, { telegramUserId: '12345', chatId: '12345', linkedUsername: 'tested_user', displayName: 'Test' }, { updateId: '102', leaseToken: claimed.leaseToken! });
    expect(result.status).toBe('linked');
    expect((await claimTelegramWebhookUpdate('102')).status).toBe('done');
    expect((await db.select().from(schema.telegramLinks)).length).toBe(1);
    expect((await db.select().from(schema.telegramLinkTokens).where(eq(schema.telegramLinkTokens.tokenHash, (await db.select().from(schema.telegramLinkTokens))[0].tokenHash)))[0].consumedAt).not.toBeNull();
  });
});
