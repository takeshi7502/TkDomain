import { NextResponse } from 'next/server';

export class HttpError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** JSON types from a client are untrusted, regardless of TypeScript casts. */
export async function readJson(request: Request, limit = 16_384): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError('Content-Type must be application/json.', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError('Invalid request body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError('Request body is too large.', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError('Invalid JSON body.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('A JSON object is required.');
  return value as Record<string, unknown>;
}

export function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof HttpError ? error.message : 'Invalid request body.' },
    { status: error instanceof HttpError ? error.status : 400 });
}

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
}

export function trustedMutation(request: Request) {
  const origin = request.headers.get('origin');
  return (!origin || origin === new URL(request.url).origin)
    && request.headers.get('sec-fetch-site') !== 'cross-site';
}
