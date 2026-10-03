import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith('/api/')) {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && path !== '/api/telegram/webhook') {
      const origin = request.headers.get('origin');
      if ((origin && origin !== request.nextUrl.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
        return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
      }
      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > 16_384) return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
      const type = request.headers.get('content-type');
      if (type && type.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return NextResponse.json({ error: 'Content-Type must be application/json.' }, { status: 415 });
      }
    }
  }
  const response = NextResponse.next();
  if (path.startsWith('/api/') && path !== '/api/registry-domains') {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");

  // Metadata differs only for Telegram's crawler. Keep shared caches from
  // returning Telegram's compact image card to Discord or normal visitors.
  if (request.nextUrl.pathname === '/') {
    response.headers.append('Vary', 'User-Agent');
  }

  return response;
}

export const config = {
  matcher: ['/', '/admin', '/manage', '/api/:path*'],
};
