import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { bootstrapLegacySchema } from '@/db/bootstrap';
import { notificationValues, processNotifications } from '@/lib/notifications';
import { createRequestAccessKey, hashOwnerAccessKey } from '@/lib/owner-auth';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';

const state = vi.hoisted(() => ({ db: null as unknown, query: null as unknown, send: vi.fn<() => Promise<string>>() }));
vi.mock('@/db', () => ({ getDb: () => state.db, ensureRegistrySchema: async () => {}, getSql: () => ({ query: state.query }) }));
vi.mock('@/lib/request-email', () => ({ notifyRequestReceived: () => state.send() }));
vi.mock('@/lib/approval-email', () => ({ notifyApprovedRequest: () => state.send() }));
vi.mock('@/lib/telegram', () => ({ notifyAdminOfNewRequest: async () => ({ sent: true, configured: true }) }));
const pg = new PGlite(), db = drizzle(pg, { schema });
beforeAll(async () => {
  state.db = db; state.query = async (text: string, values: unknown[]) => (await pg.query(text, values)).rows;
  process.env.REGISTRY_ADMIN_KEY = 'test-original-root';
  await bootstrapLegacySchema({ query: (text, values) => pg.query(text, values) });
  await pg.exec(await readFile(new URL('../drizzle/0009_stability.sql', import.meta.url), 'utf8'));
});
afterAll(async () => { delete process.env.REGISTRY_ADMIN_KEY; delete process.env.REGISTRY_AUTH_SECRET; await pg.close(); });
describe('notification outbox and compatibility', () => {
  it('preserves existing hashes and generated keys when separating admin/auth roots', () => {
    const key = createRequestAccessKey('existing-request'), oldHash = hashOwnerAccessKey(key);
    expect(oldHash).toBe(createHmac('sha256', 'test-original-root').update(key).digest('hex'));
    process.env.REGISTRY_AUTH_SECRET = 'test-original-root';
    process.env.REGISTRY_ADMIN_KEY = 'changed-admin-password';
    expect(createRequestAccessKey('existing-request')).toBe(key);
    expect(hashOwnerAccessKey(key)).toBe(oldHash);
  });
  it('caps counter overflow and uses independent scopes', async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, () => enforceRegistryScopedRateLimit('test', 'owner-1', 3, 60000)));
    expect(attempts.filter((r) => r.allowed)).toHaveLength(3);
    expect((await enforceRegistryScopedRateLimit('test', 'owner-2', 3, 60000)).allowed).toBe(true);
    const rates = await db.select().from(schema.registryRateLimits);
    expect(rates.some((r) => r.hits === 4)).toBe(true);
  });
  it('rolls the request and its outbox back together', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.subdomainRequests).values({ id: 'rolled-back', subdomain: 'rolled', cnameTarget: 'example.com', email: '', createdAt: 1 });
      await tx.insert(schema.notificationJobs).values(notificationValues('rolled-back', ['receipt']));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await db.select().from(schema.notificationJobs)).toHaveLength(0);
  });
  it('retries failures and never repeats accepted deliveries', async () => {
    await db.insert(schema.subdomainRequests).values({ id: 'request', subdomain: 'test', cnameTarget: 'example.com', email: '', createdAt: 1 });
    const values = notificationValues('request', ['receipt']);
    expect(JSON.stringify(values)).not.toContain('accessKey');
    await db.insert(schema.notificationJobs).values(values);
    state.send.mockResolvedValueOnce('failed');
    await processNotifications();
    const [waiting] = await db.select().from(schema.notificationJobs);
    expect(waiting.status).toBe('pending'); expect(waiting.attempts).toBe(1);
    await db.update(schema.notificationJobs).set({ nextAttemptAt: 0 }).where(eq(schema.notificationJobs.id, waiting.id));
    state.send.mockResolvedValueOnce('accepted');
    await processNotifications(); await processNotifications();
    expect((await db.select().from(schema.notificationJobs))[0].status).toBe('done');
    expect(state.send).toHaveBeenCalledTimes(2);
  });
});
