import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { ensureRegistrySchema, getDb } from '@/db';
import { owners, subdomains } from '@/db/schema';
import { clearOwnerSessionCookie, createOwnerSession, getOwnerSession, hashOwnerAccessKey, removeOwnerSession, setOwnerSessionCookie } from '@/lib/owner-auth';

function ownerProfile(owner: typeof owners.$inferSelect) {
  return { email: owner.email, githubHandle: owner.githubHandle };
}

export async function GET(request: NextRequest) {
  const session = await getOwnerSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const domains = await getDb().select({ id: subdomains.id, label: subdomains.label, status: subdomains.status }).from(subdomains).where(eq(subdomains.ownerId, session.owner.id));
  return NextResponse.json({ owner: ownerProfile(session.owner), subdomains: domains });
}

export async function POST(request: NextRequest) {
  let body: { accessKey?: string };
  try { body = await request.json() as { accessKey?: string }; } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  const accessKey = body.accessKey?.trim();
  if (!accessKey || accessKey.length > 200) return NextResponse.json({ error: 'Access key không hợp lệ.' }, { status: 400 });

  await ensureRegistrySchema();
  const owner = await getDb().query.owners.findFirst({ where: eq(owners.accessKeyHash, hashOwnerAccessKey(accessKey)) });
  if (!owner || owner.status !== 'active') return NextResponse.json({ error: 'Access key không đúng hoặc đã bị thu hồi.' }, { status: 401 });

  const token = await createOwnerSession(owner.id);
  const response = NextResponse.json({ ok: true, owner: ownerProfile(owner) });
  setOwnerSessionCookie(response, token);
  return response;
}

export async function DELETE(request: NextRequest) {
  await removeOwnerSession(request);
  const response = NextResponse.json({ ok: true });
  clearOwnerSessionCookie(response);
  return response;
}
