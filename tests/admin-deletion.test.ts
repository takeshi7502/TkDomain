import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { bootstrapLegacySchema } from '@/db/bootstrap';
import { DELETE } from '@/app/api/admin/subdomains/route';
import { beginAdminSubdomainDeletion, beginDnsOperation, runDnsOperation } from '@/lib/dns-operations';
import { buildDeletionEmail } from '@/lib/approval-email-message';
import { processNotifications } from '@/lib/notifications';

const state = vi.hoisted(() => ({ db: null as unknown, authorized: true, allowed: true,
  provider: new Set<string>(), calls: 0, failDelete: false, emailAccepted: true,
  mail: vi.fn<typeof fetch>() }));
vi.mock('@/db', () => ({ getDb: () => state.db, ensureRegistrySchema: async () => {} }));
vi.mock('@/lib/admin-auth', () => ({ isAdminAuthorized: () => state.authorized }));
vi.mock('@/lib/rate-limit', () => ({ enforceRegistryRateLimit: async () => ({ allowed: state.allowed, retryAfterSeconds: 60 }), enforceRegistryScopedRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/telegram', () => ({ sendTelegramMessageToOwner: vi.fn(), notifyAdminOfNewRequest: vi.fn() }));
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: () => {} }));
vi.mock('@/lib/cloudflare', () => ({ CloudflareError: class extends Error {},
  createCloudflareRecord: vi.fn(), updateCloudflareRecord: vi.fn(), findCloudflareRecordByComment: vi.fn(),
  deleteCloudflareRecord: async (id: string) => {
    state.calls++;
    state.provider.delete(id);
    if (state.failDelete) { state.failDelete = false; throw new Error('Lost response after provider deleted record'); }
  },
}));

const pg = new PGlite(), db = drizzle(pg, { schema });
const deletion = (notifyEmail = true) => ({ id: crypto.randomUUID(), subdomainId: 'domain', confirmation: 'test.takeshi.dev', reason: 'Vi phạm quy định sử dụng.', notifyEmail });
const apiRequest = (body: unknown, origin = 'https://domain.takeshi.dev') => new NextRequest('https://domain.takeshi.dev/api/admin/subdomains', {
  method: 'DELETE', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body),
});
const bodyFor = (args: ReturnType<typeof deletion>) => ({ ...args, operationId: args.id });

beforeAll(async () => {
  state.db = db;
  await bootstrapLegacySchema({ query: (text, values) => pg.query(text, values) });
  await pg.exec(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await pg.exec('TRUNCATE notification_jobs, dns_events, dns_operations, dns_records, subdomains, owners, subdomain_requests CASCADE');
  state.authorized = true; state.allowed = true; state.calls = 0; state.failDelete = false; state.emailAccepted = true;
  state.provider.clear(); state.provider.add('primary-cf'); state.mail.mockReset();
  state.mail.mockImplementation(async () => state.emailAccepted ? new Response(JSON.stringify({ id: 'email-delivered' }), { status: 200 }) : new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', state.mail);
  process.env.RESEND_API_KEY = 'test-only-key'; process.env.EMAIL_FROM = 'Test <notify@example.com>';
  await db.update(schema.managedDomains).set({ cloudflareZoneId: 'a'.repeat(32) }).where(eq(schema.managedDomains.id, schema.TAKESHI_DEV_MANAGED_DOMAIN_ID));
  await db.insert(schema.subdomainRequests).values({ id: 'request', subdomain: 'test', cnameTarget: '203.0.113.10', recordType: 'A', status: 'active', email: '', notificationEmail: 'user@example.com', createdAt: 1 });
  await db.insert(schema.owners).values({ id: 'owner', email: 'owner:request', accessKeyHash: 'hash', createdAt: 1, updatedAt: 1 });
  await db.insert(schema.subdomains).values({ id: 'domain', label: 'test', ownerId: 'owner', requestId: 'request', createdAt: 1, updatedAt: 1 });
  await db.insert(schema.dnsRecords).values({ id: 'primary', subdomainId: 'domain', recordType: 'A', recordName: '@', content: '203.0.113.10', isPrimary: true, cloudflareRecordId: 'primary-cf', createdAt: 1, updatedAt: 1 });
});
afterAll(async () => { vi.unstubAllGlobals(); delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; await pg.close(); });

describe('admin deletion authorization and confirmation', () => {
  it('rejects unauthenticated and cross-origin mutations before DNS changes', async () => {
    state.authorized = false;
    expect((await DELETE(apiRequest(bodyFor(deletion())))).status).toBe(401);
    state.authorized = true;
    expect((await DELETE(apiRequest(bodyFor(deletion()), 'https://evil.takeshi.dev'))).status).toBe(403);
    expect(state.calls).toBe(0);
  });
  it('rejects malformed options, missing reason, incorrect hostname and rate-limited writes', async () => {
    const args = bodyFor(deletion());
    for (const change of [{ notifyEmail: 'false' }, { reason: '' }, { reason: 'x'.repeat(501) }, { confirmation: 'other.takeshi.dev' }, { operationId: {} }]) {
      expect((await DELETE(apiRequest({ ...args, ...change }))).status).toBe(400);
    }
    state.allowed = false;
    const response = await DELETE(apiRequest(args)); expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
    expect(state.calls).toBe(0); expect(await db.select().from(schema.dnsOperations)).toHaveLength(0);
  });
  it('does not silently promise mail for a legacy subdomain with no notification address', async () => {
    await db.update(schema.subdomainRequests).set({ notificationEmail: null }).where(eq(schema.subdomainRequests.id, 'request'));
    expect((await DELETE(apiRequest(bodyFor(deletion())))).status).toBe(409);
    expect(state.calls).toBe(0);
    expect((await DELETE(apiRequest(bodyFor(deletion(false))))).status).toBe(200);
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(0);
  });
});

describe('durable admin deletion and optional mail', () => {
  it('deletes DNS and owner security data, preserving reason, history and queued mail', async () => {
    await db.insert(schema.ownerSessions).values({ id: 'session', ownerId: 'owner', tokenHash: 'session-hash', expiresAt: Date.now() + 10000, createdAt: 1 });
    await db.insert(schema.telegramLinks).values({ id: 'link', ownerId: 'owner', telegramUserId: '1234', chatId: '1234', linkedAt: 1, updatedAt: 1 });
    await db.insert(schema.telegramLinkTokens).values({ id: 'token', ownerId: 'owner', tokenHash: 'token-hash', expiresAt: Date.now() + 10000, createdAt: 1 });
    const args = deletion(), response = await DELETE(apiRequest(bodyFor(args)));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ownerDeleted: true, deletionEmail: 'queued' });
    expect(state.provider.size).toBe(0);
    for (const table of [schema.owners, schema.subdomains, schema.dnsRecords, schema.ownerSessions, schema.telegramLinks, schema.telegramLinkTokens]) expect(await db.select().from(table)).toHaveLength(0);
    const [request] = await db.select().from(schema.subdomainRequests);
    expect(request.status).toBe('released'); expect(request.reviewerNote).toBe(args.reason);
    const logs = await db.select().from(schema.dnsEvents);
    expect(logs).toHaveLength(2); expect(logs.every((log) => log.actorType === 'admin' && log.subdomainId === null)).toBe(true);
    expect(logs.find((log) => log.action === 'subdomain_deleted')?.details).toMatchObject({ reason: args.reason, notifyEmail: true });
    expect((await db.select().from(schema.notificationJobs))[0]).toMatchObject({ requestId: 'request', kind: 'deletion', status: 'pending' });
    await processNotifications('request'); await processNotifications('request');
    expect(state.mail).toHaveBeenCalledTimes(1);
    const email = JSON.parse(String(state.mail.mock.calls[0][1]?.body));
    expect(email.to).toEqual(['user@example.com']); expect(email.text).toContain(args.reason);
    expect((await db.select().from(schema.notificationJobs))[0].status).toBe('done');
    // A lost HTTP response can be retried after both domain and owner are gone.
    expect((await DELETE(apiRequest(bodyFor(args)))).status).toBe(200);
    expect(state.calls).toBe(1); expect(await db.select().from(schema.notificationJobs)).toHaveLength(1);
  });
  it('honors email opt-out while keeping deletion audit', async () => {
    const args = deletion(false); await beginAdminSubdomainDeletion(args);
    expect(await runDnsOperation(args.id)).toMatchObject({ deletionEmail: 'skipped' });
    await processNotifications(); expect(state.mail).not.toHaveBeenCalled();
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(0);
    expect((await db.select().from(schema.dnsEvents)).find((log) => log.action === 'subdomain_deleted')?.details).toMatchObject({ reason: args.reason, notifyEmail: false });
  });
  it('never frees the name or queues mail before the complete DNS deletion commits', async () => {
    for (let i = 0; i < 9; i++) {
      const id = `child${i}`; state.provider.add(id);
      await db.insert(schema.dnsRecords).values({ id, subdomainId: 'domain', recordType: 'TXT', recordName: id, content: 'value', cloudflareRecordId: id, createdAt: 1, updatedAt: 1 });
    }
    const args = deletion(); await beginAdminSubdomainDeletion(args);
    expect(await runDnsOperation(args.id)).toMatchObject({ pending: true });
    expect((await db.select().from(schema.subdomains))[0].status).toBe('deleting');
    expect((await db.select().from(schema.subdomainRequests))[0].status).toBe('active');
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(0);
    await expect(beginDnsOperation({ id: crypto.randomUUID(), ownerId: 'owner', subdomainId: 'domain', kind: 'release' })).rejects.toMatchObject({ status: 409 });
    expect(await runDnsOperation(args.id)).toMatchObject({ deletionEmail: 'queued' });
    expect(state.provider.size).toBe(0); expect(await db.select().from(schema.dnsEvents)).toHaveLength(11);
  });
  it('recovers a provider timeout without discarding the reason or duplicating mail', async () => {
    const args = deletion(); await beginAdminSubdomainDeletion(args); state.failDelete = true;
    expect(await runDnsOperation(args.id)).toMatchObject({ pending: true });
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(0);
    await db.update(schema.dnsOperations).set({ leaseUntil: 0 }).where(eq(schema.dnsOperations.id, args.id));
    expect(await runDnsOperation(args.id)).toMatchObject({ deletionEmail: 'queued' });
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(1);
  });
  it('keeps the owner and other domains intact and allows admin deletion for a disabled owner', async () => {
    await db.insert(schema.subdomains).values({ id: 'other', label: 'other', ownerId: 'owner', createdAt: 1, updatedAt: 1 });
    await db.update(schema.owners).set({ status: 'disabled' }).where(eq(schema.owners.id, 'owner'));
    const args = deletion(false); await beginAdminSubdomainDeletion(args);
    expect(await runDnsOperation(args.id)).toMatchObject({ ownerDeleted: false });
    expect((await db.select().from(schema.subdomains)).map((r) => r.id)).toEqual(['other']);
    expect(await db.select().from(schema.owners)).toHaveLength(1);
  });
  it('rejects changed confirmation options or a different subdomain on a reused operation ID', async () => {
    const args = deletion(); await beginAdminSubdomainDeletion(args);
    for (const change of [{ reason: 'Different reason' }, { notifyEmail: false }, { subdomainId: 'other' }, { confirmation: 'other.takeshi.dev' }]) await expect(beginAdminSubdomainDeletion({ ...args, ...change })).rejects.toMatchObject({ status: 409 });
    expect(state.calls).toBe(0);
  });
  it('retries failed email through the outbox, independently of DNS success', async () => {
    const args = deletion(); await beginAdminSubdomainDeletion(args); await runDnsOperation(args.id);
    state.emailAccepted = false; await processNotifications();
    const [job] = await db.select().from(schema.notificationJobs); expect(job.status).toBe('pending');
    expect(await db.select().from(schema.subdomains)).toHaveLength(0);
    state.emailAccepted = true;
    await db.update(schema.notificationJobs).set({ nextAttemptAt: 0 }).where(eq(schema.notificationJobs.id, job.id));
    await processNotifications(); expect((await db.select().from(schema.notificationJobs))[0].status).toBe('done');
    expect(state.mail.mock.calls[0][1]?.headers).toEqual(state.mail.mock.calls[1][1]?.headers);
    expect(state.mail.mock.calls[0][1]?.body).toEqual(state.mail.mock.calls[1][1]?.body);
  });
  it('stops uncertain email retries outside the provider deduplication window', async () => {
    const args = deletion(); await beginAdminSubdomainDeletion(args); await runDnsOperation(args.id);
    await db.update(schema.notificationJobs).set({ createdAt: Date.now() - 24 * 60 * 60_000, attempts: 1 });
    await processNotifications(); expect(state.mail).not.toHaveBeenCalled();
    expect((await db.select().from(schema.notificationJobs))[0].status).toBe('failed');
  });
  it('escapes admin reason and supports VI/EN without leaking an access key', () => {
    const viMessage = buildDeletionEmail({ hostname: 'test.takeshi.dev', language: 'vi', reason: '<script>alert(1)</script> & lý do' });
    expect(viMessage.html).not.toContain('<script>'); expect(viMessage.html).toContain('&lt;script&gt;'); expect(viMessage.text).toContain('Lý do:');
    const enMessage = buildDeletionEmail({ hostname: 'test.takeshi.dev', language: 'en', reason: 'Policy violation.' });
    expect(enMessage.subject).toContain('subdomain deleted'); expect(enMessage.text).toContain('Reason: Policy violation.');
    expect(enMessage.text).not.toContain('tk-');
  });
});
