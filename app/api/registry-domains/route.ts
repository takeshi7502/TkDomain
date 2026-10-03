import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { managedDomains } from '@/db/schema';

/** Public, non-sensitive list used by the suffix selector on the claim form. */
export async function GET() {
  await ensureRegistrySchema();
  const domains = await getDb()
    .select({ id: managedDomains.id, hostname: managedDomains.hostname })
    .from(managedDomains)
    .where(and(eq(managedDomains.status, 'active'), isNotNull(managedDomains.cloudflareZoneId)))
    .orderBy(asc(managedDomains.hostname));

  return NextResponse.json(
    { domains },
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=30' } },
  );
}
