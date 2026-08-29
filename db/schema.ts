import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';

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
