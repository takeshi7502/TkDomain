import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { getDb } from '@/db';
import { dnsEvents, dnsOperations, dnsRecords, managedDomains, owners, subdomainRequests, subdomains } from '@/db/schema';
import { CloudflareError, createCloudflareRecord, deleteCloudflareRecord, findCloudflareRecordByComment, updateCloudflareRecord } from '@/lib/cloudflare';
import { fullRecordName, type ValidatedDnsRecord } from '@/lib/dns';
import { HttpError } from '@/lib/http';
import { sendTelegramMessageToOwner } from '@/lib/telegram';
import { enforceRegistryScopedRateLimit } from '@/lib/rate-limit';

type RecordRow = typeof dnsRecords.$inferSelect;
type Kind = typeof dnsOperations.$inferSelect.kind;
type Payload = {
  label: string; parentDomain: string; zoneId: string; requestId: string | null;
  before: RecordRow | null; after: ValidatedDnsRecord | null; recordId: string;
  records?: RecordRow[]; deleted?: number;
};
type Result = { ok: true; pending?: boolean; operationId?: string; ownerDeleted?: boolean; hostname?: string };
const LEASE_MS = 120_000;

export function recordLimit() {
  const n = Number(process.env.DNS_RECORD_LIMIT ?? 50);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50;
}

export function validateRecordChange(records: RecordRow[], after: ValidatedDnsRecord, current?: RecordRow) {
  if (current?.isPrimary && after.recordName !== '@') throw new HttpError('Tên record chính phải là @.');
  const others = records.filter((r) => r.id !== current?.id && r.recordName === after.recordName);
  if (others.some((r) => r.recordType === 'CNAME' || after.recordType === 'CNAME')) throw new HttpError('CNAME không thể dùng chung tên với record khác.', 409);
  if (others.some((r) => r.recordType === after.recordType && r.content === after.content)) throw new HttpError('Record này đã tồn tại.', 409);
}

/** Claim inside the domain lock BEFORE making any external change. */
export async function beginDnsOperation(args: {
  ownerId: string; subdomainId: string; kind: Kind; id: string;
  recordId?: string; after?: ValidatedDnsRecord;
}): Promise<{ id: string; unchanged?: boolean }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: owners.id }).from(owners)
      .where(and(eq(owners.id, args.ownerId), eq(owners.status, 'active'))).for('update');
    if (!owner) throw new HttpError('Owner không còn active.', 404);
    const [domain] = await tx.select().from(subdomains)
      .where(and(eq(subdomains.id, args.subdomainId), eq(subdomains.ownerId, args.ownerId))).for('update');
    if (!domain) throw new HttpError('Subdomain không thuộc quyền quản lý của bạn.', 404);
    const [existing] = await tx.select().from(dnsOperations).where(eq(dnsOperations.id, args.id));
    if (existing) {
      if (existing.ownerId !== args.ownerId || existing.subdomainId !== args.subdomainId || existing.kind !== args.kind) throw new HttpError('Operation ID không hợp lệ.', 409);
      // A key always replays its original payload, never a later edited input.
      const old = existing.payload as Payload;
      const recordKeys = ['recordType', 'recordName', 'content', 'ttl', 'proxied', 'priority'] as const;
      const sameRecord = old.after === null ? !args.after
        : args.after && recordKeys.every((key) => old.after![key] === args.after![key]);
      if ((args.recordId && old.before?.id !== args.recordId) || !sameRecord) throw new HttpError('Yêu cầu đã đổi. Hãy dùng operation ID mới.', 409);
      if (existing.status === 'failed') throw new HttpError('Thao tác trước bị từ chối. Hãy tải lại panel và gửi yêu cầu mới.', 409);
      return { id: existing.id };
    }
    const [busy] = await tx.select().from(dnsOperations).where(and(eq(dnsOperations.subdomainId, domain.id), eq(dnsOperations.status, 'pending')));
    if (busy) {
      // Once confirmed, a release is resumable without reusing the OTP.
      if (args.kind === 'release' && busy.kind === 'release') return { id: busy.id };
      throw new HttpError('DNS đang được đồng bộ. Hãy chờ rồi tải lại panel.', 409);
    }
    if (domain.status !== 'active') throw new HttpError('Subdomain không còn active.', 409);
    const [parent] = await tx.select().from(managedDomains).where(eq(managedDomains.id, domain.parentDomainId));
    if (!parent?.cloudflareZoneId) throw new HttpError('Cloudflare chưa được cấu hình cho domain này.', 409);
    const records = await tx.select().from(dnsRecords).where(eq(dnsRecords.subdomainId, domain.id));
    const before = records.find((r) => r.id === args.recordId) ?? null;
    if ((args.kind === 'update' || args.kind === 'delete') && !before) throw new HttpError('Record không tồn tại.', 404);
    if (args.kind === 'delete' && before?.isPrimary) throw new HttpError('Hãy dùng chức năng xóa toàn bộ subdomain để xóa record chính.', 409);
    if (args.kind === 'create' && records.length >= recordLimit()) throw new HttpError(`Tối đa ${recordLimit()} record trên một subdomain.`, 409);
    if (args.after) {
      if (fullRecordName(domain.label, args.after.recordName, parent.hostname).length > 253) throw new HttpError('Tên DNS quá dài.');
      validateRecordChange(records, args.after, before ?? undefined);
      if (before && ['recordType', 'recordName', 'content', 'ttl', 'proxied', 'priority'].every((k) => before[k as keyof RecordRow] === args.after![k as keyof ValidatedDnsRecord])) return { id: args.id, unchanged: true };
    }
    const now = Date.now();
    const payload: Payload = {
      label: domain.label, parentDomain: parent.hostname, zoneId: parent.cloudflareZoneId,
      requestId: domain.requestId, before, after: args.after ?? null,
      recordId: before?.id ?? crypto.randomUUID(),
      ...(args.kind === 'release' ? { records, deleted: 0 } : {}),
    };
    await tx.insert(dnsOperations).values({ id: args.id, ownerId: args.ownerId, subdomainId: domain.id, kind: args.kind, payload, createdAt: now, updatedAt: now });
    if (args.kind === 'release') await tx.update(subdomains).set({ status: 'deleting', updatedAt: now }).where(eq(subdomains.id, domain.id));
    return { id: args.id };
  });
}

function summary(r: ValidatedDnsRecord | RecordRow) { return { type: r.recordType, name: r.recordName, ttl: r.ttl, proxied: r.proxied, priority: r.priority }; }

/** Retries the SAME durable operation; other mutations remain blocked meanwhile. */
export async function runDnsOperation(id: string): Promise<Result> {
  const db = getDb();
  const [original] = await db.select().from(dnsOperations).where(eq(dnsOperations.id, id));
  if (!original) throw new HttpError('Operation không tồn tại.', 404);
  if (original.status === 'done') return original.result as Result;
  if (original.status === 'failed') throw new HttpError('Cloudflare đã từ chối thao tác này. Hãy gửi lại sau khi sửa thông tin.', 409);
  const now = Date.now(), leaseToken = crypto.randomUUID();
  const [op] = await db.update(dnsOperations).set({ leaseToken, leaseUntil: now + LEASE_MS, attempts: sql`${dnsOperations.attempts} + 1`, updatedAt: now })
    .where(and(eq(dnsOperations.id, id), eq(dnsOperations.status, 'pending'), lt(dnsOperations.leaseUntil, now))).returning();
  if (!op) return { ok: true, pending: true, operationId: id };
  const p = op.payload as Payload;
  let providerId = p.before?.cloudflareRecordId ?? '';
  let externalApplied = false;
  try {
    const budget = await enforceRegistryScopedRateLimit('dns-provider-operation', 'registry', 60, 60_000);
    if (!budget.allowed) throw new Error('Provider operation budget reached.');
    if (op.kind === 'create') {
      const name = fullRecordName(p.label, p.after!.recordName, p.parentDomain);
      const comment = `Takeshi Domains operation ${op.id}`;
      providerId = await findCloudflareRecordByComment(name, p.after!, comment, p.zoneId)
        ?? await createCloudflareRecord(name, p.after!, comment, p.zoneId);
      externalApplied = true;
    } else if (op.kind === 'update') {
      await updateCloudflareRecord(providerId, fullRecordName(p.label, p.after!.recordName, p.parentDomain), p.after!, `Takeshi Domains operation ${op.id}`, p.zoneId);
      externalApplied = true;
    } else if (op.kind === 'delete') {
      await deleteCloudflareRecord(providerId, p.zoneId); externalApplied = true;
    } else {
      // Bounded batches fit serverless execution limits, progress survives crashes.
      const end = Math.min((p.deleted ?? 0) + 5, p.records!.length);
      for (let i = p.deleted ?? 0; i < end; i++) {
        await deleteCloudflareRecord(p.records![i].cloudflareRecordId, p.zoneId);
        p.deleted = i + 1; externalApplied = true;
        const rows = await db.update(dnsOperations).set({ payload: p, attempts: 0, updatedAt: Date.now() }).where(and(eq(dnsOperations.id, id), eq(dnsOperations.leaseToken, leaseToken))).returning({ id: dnsOperations.id });
        if (!rows.length) return { ok: true, pending: true, operationId: id };
      }
      if (end < p.records!.length) {
        await db.update(dnsOperations).set({ leaseUntil: 0, leaseToken: null }).where(and(eq(dnsOperations.id, id), eq(dnsOperations.leaseToken, leaseToken)));
        return { ok: true, pending: true, operationId: id };
      }
    }
    const result = await db.transaction(async (tx): Promise<Result> => {
      // Same lock order as key rotation / Telegram flows: owner → domain.
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, op.ownerId)).for('update');
      const [domain] = await tx.select().from(subdomains).where(eq(subdomains.id, op.subdomainId)).for('update');
      const [claimed] = await tx.select().from(dnsOperations).where(and(eq(dnsOperations.id, id), eq(dnsOperations.leaseToken, leaseToken), eq(dnsOperations.status, 'pending'))).for('update');
      if (!claimed || !domain || domain.ownerId !== op.ownerId) throw new Error('Operation lease changed.');
      const time = Date.now();
      let ownerDeleted = false;
      if (op.kind === 'release') {
        const records = p.records!;
        await tx.insert(dnsEvents).values([
          ...records.map((r) => ({ id: crypto.randomUUID(), subdomainId: domain.id, domainLabel: p.label, parentDomain: p.parentDomain, recordId: r.id, actorType: 'owner' as const, action: r.isPrimary ? 'primary_record_deleted' : 'child_record_deleted', details: { ...summary(r), source: 'subdomain_release' }, createdAt: time })),
          { id: crypto.randomUUID(), subdomainId: domain.id, domainLabel: p.label, parentDomain: p.parentDomain, actorType: 'owner', action: 'subdomain_released', details: { deletedRecordCount: records.length }, createdAt: time },
        ]);
        if (p.requestId) await tx.update(subdomainRequests).set({ status: 'released', releasedAt: time }).where(and(eq(subdomainRequests.id, p.requestId), eq(subdomainRequests.status, 'active')));
        await tx.delete(subdomains).where(eq(subdomains.id, domain.id));
        const [{ value }] = await tx.select({ value: count() }).from(subdomains).where(eq(subdomains.ownerId, op.ownerId));
        if (value === 0) { await tx.delete(owners).where(eq(owners.id, op.ownerId)); ownerDeleted = true; }
      } else {
        if (op.kind === 'create') await tx.insert(dnsRecords).values({ id: p.recordId, subdomainId: domain.id, ...p.after!, isPrimary: false, cloudflareRecordId: providerId, createdAt: time, updatedAt: time });
        if (op.kind === 'update') await tx.update(dnsRecords).set({ ...p.after!, updatedAt: time }).where(eq(dnsRecords.id, p.recordId));
        if (op.kind === 'delete') await tx.delete(dnsRecords).where(eq(dnsRecords.id, p.recordId));
        await tx.update(subdomains).set({ updatedAt: time }).where(eq(subdomains.id, domain.id));
        await tx.insert(dnsEvents).values({ id: crypto.randomUUID(), subdomainId: domain.id, domainLabel: p.label, parentDomain: p.parentDomain, recordId: p.recordId, actorType: 'owner', action: `${p.before?.isPrimary ? 'primary' : 'child'}_record_${op.kind === 'create' ? 'created' : op.kind === 'update' ? 'updated' : 'deleted'}`, details: { ...summary(p.after ?? p.before!), operationId: id }, createdAt: time });
      }
      const done: Result = { ok: true, ...(op.kind === 'release' ? { ownerDeleted, hostname: `${p.label}.${p.parentDomain}` } : {}) };
      await tx.update(dnsOperations).set({ status: 'done', result: done, leaseToken: null, leaseUntil: 0, lastError: null, updatedAt: time }).where(eq(dnsOperations.id, id));
      return done;
    });
    // Optional notifications must not change a committed operation's outcome.
    after(async () => {
      try { await sendTelegramMessageToOwner(op.ownerId, `TAKESHI DOMAINS\nDNS ${op.kind}: ${p.label}.${p.parentDomain}\nMở DNS Panel để xem chi tiết.`); }
      catch { console.warn('Optional DNS notification failed.'); }
    });
    return result;
  } catch (error) {
    // Only a definitive rejection BEFORE any change may free the domain.
    const rejected = !externalApplied && op.kind !== 'release' && error instanceof CloudflareError && error.definitive;
    await db.update(dnsOperations).set({ status: rejected ? 'failed' : 'pending', leaseToken: null, leaseUntil: Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(op.attempts, 6)), lastError: rejected ? 'provider_rejected' : 'reconciliation_required', updatedAt: Date.now() }).where(and(eq(dnsOperations.id, id), eq(dnsOperations.leaseToken, leaseToken)));
    if (rejected) throw new HttpError('Cloudflare từ chối record. Kiểm tra nội dung rồi gửi lại.', 502);
    return { ok: true, pending: true, operationId: id };
  }
}

export async function resumeDnsOperations(ownerId?: string, limit = 2, deadline = Infinity) {
  const ops = await getDb().select({ id: dnsOperations.id }).from(dnsOperations)
    .where(and(eq(dnsOperations.status, 'pending'), lt(dnsOperations.leaseUntil, Date.now()), lt(dnsOperations.attempts, 8), ...(ownerId ? [eq(dnsOperations.ownerId, ownerId)] : [])))
    .orderBy(asc(dnsOperations.createdAt)).limit(limit);
  let processed = 0;
  for (const op of ops) {
    if (Date.now() > deadline - 60_000) break;
    await runDnsOperation(op.id); processed++;
  }
  return processed;
}

export async function releaseInProgress(ownerId: string, subdomainId: string) {
  const [op] = await getDb().select({ id: dnsOperations.id }).from(dnsOperations)
    .where(and(eq(dnsOperations.ownerId, ownerId), eq(dnsOperations.subdomainId, subdomainId), eq(dnsOperations.kind, 'release'), inArray(dnsOperations.status, ['pending', 'done']))).orderBy(asc(dnsOperations.createdAt)).limit(1);
  return op?.id ?? null;
}
