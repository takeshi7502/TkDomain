import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const response = NextResponse.next();

  // Metadata differs only for Telegram's crawler. Keep shared caches from
  // returning Telegram's compact image card to Discord or normal visitors.
  if (request.nextUrl.pathname === '/') {
    response.headers.append('Vary', 'User-Agent');
  }

  return response;
}

export const config = {
  matcher: '/',
};
