import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const subdomainRequests = pgTable(
  'subdomain_requests',
  {
    id: text('id').primaryKey(),
    subdomain: text('subdomain').notNull().unique(),
    cnameTarget: text('cname_target').notNull(),
    githubHandle: text('github_handle'),
    email: text('email').notNull(),
    status: text('status', { enum: ['pending', 'active', 'rejected'] }).notNull().default('pending'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    reviewedAt: bigint('reviewed_at', { mode: 'number' }),
    reviewerNote: text('reviewer_note'),
    cloudflareRecordId: text('cloudflare_record_id'),
  },
  (table) => [
    index('idx_subdomain_requests_status_created').on(table.status, table.createdAt),
    index('idx_subdomain_requests_email_created').on(table.email, table.createdAt),
  ],
);

export const owners = pgTable(
  'owners',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    githubHandle: text('github_handle'),
    accessKeyHash: text('access_key_hash'),
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_owners_access_key_hash').on(table.accessKeyHash)],
);

export const subdomains = pgTable(
  'subdomains',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull().unique(),
    ownerId: text('owner_id').notNull().references(() => owners.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
    requestId: text('request_id').references(() => subdomainRequests.id, { onDelete: 'set null' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_subdomains_owner_status').on(table.ownerId, table.status)],
);

export const dnsRecords = pgTable(
  'dns_records',
  {
    id: text('id').primaryKey(),
    subdomainId: text('subdomain_id').notNull().references(() => subdomains.id, { onDelete: 'cascade' }),
    recordType: text('record_type', { enum: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'] }).notNull(),
    recordName: text('record_name').notNull().default('@'),
    content: text('content').notNull(),
    ttl: integer('ttl').notNull().default(1),
    proxied: boolean('proxied').notNull().default(false),
    priority: integer('priority'),
    cloudflareRecordId: text('cloudflare_record_id').notNull().unique(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_dns_records_subdomain_name').on(table.subdomainId, table.recordName),
    uniqueIndex('dns_records_identity_unique').on(table.subdomainId, table.recordType, table.recordName, table.content),
  ],
);

export const ownerSessions = pgTable(
  'owner_sessions',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => owners.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_owner_sessions_owner_expiry').on(table.ownerId, table.expiresAt)],
);

export const dnsEvents = pgTable(
  'dns_events',
  {
    id: text('id').primaryKey(),
    subdomainId: text('subdomain_id').notNull().references(() => subdomains.id, { onDelete: 'cascade' }),
    recordId: text('record_id'),
    actorType: text('actor_type', { enum: ['admin', 'owner', 'system'] }).notNull(),
    action: text('action').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_dns_events_subdomain_created').on(table.subdomainId, table.createdAt)],
);
