import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
    const headers = new Headers(request.headers);
    headers.delete('origin');
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api-proxy/:path*' };
