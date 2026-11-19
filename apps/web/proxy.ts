import { NextResponse, type NextRequest } from 'next/server';
import { guardSession, isMasterOnlyPath } from './lib/session-guard';

const apiUrl = () => process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000/api/v1';

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api-proxy')) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
      const headers = new Headers(request.headers);
      headers.delete('origin');
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }
  if (isMasterOnlyPath(request.nextUrl.pathname)) return NextResponse.rewrite(new URL('/not-found-master-only', request.url), { status: 404 });
  return (await guardSession(request, { cookieName: 'rm_restaurant_token', apiUrl: apiUrl() })) ?? NextResponse.next();
}

// Pages only: static assets, Next internals and files with an extension are skipped; /api-proxy keeps the origin handling above.
export const config = { matcher: ['/api-proxy/:path*', '/((?!_next/|api-proxy|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)'] };
