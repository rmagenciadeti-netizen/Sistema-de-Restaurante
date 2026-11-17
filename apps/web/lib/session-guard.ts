import { NextResponse, type NextRequest } from 'next/server';

// Server-side guard for page navigations. The session token lives in localStorage for the app code and is mirrored into a cookie
// (see setSessionCookie in lib/api.ts) so the server can see it: a missing, expired or API-rejected session is answered with a redirect
// to /login (and the cookie is cleared) instead of rendering the page or leaking a bare HTTP 401. The API still enforces authentication.
const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/loja', '/m', '/demo'];
const CHECK_TTL_MS = 15_000;
const verified = new Map<string, number>();

export const isPublicPath = (pathname: string) => PUBLIC_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function tokenExpired(token: string, now = Date.now()): boolean {
  const payload = token.split('.')[1];
  if (!payload) return true;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof exp === 'number' && exp * 1000 <= now;
  } catch { return true; }
}

// Next requires an absolute URL here; it is built from the host the browser used (x-forwarded-* behind Codespaces/reverse proxies).
export function loginUrl(request: NextRequest): string {
  const first = (value: string | null) => value?.split(',')[0].trim() || null;
  const host = first(request.headers.get('x-forwarded-host')) ?? request.headers.get('host') ?? request.nextUrl.host;
  const proto = first(request.headers.get('x-forwarded-proto')) ?? request.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}/login`;
}

export function redirectToLogin(request: NextRequest, cookieName: string): NextResponse {
  const response = NextResponse.redirect(loginUrl(request), 307);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set({ name: cookieName, value: '', path: '/', maxAge: 0 });
  return response;
}

type GuardOptions = { cookieName: string; apiUrl: string; fetchImpl?: typeof fetch; now?: number };

// Returns a redirect when the session is not valid, or null to let the request continue.
export async function guardSession(request: NextRequest, { cookieName, apiUrl, fetchImpl = fetch, now = Date.now() }: GuardOptions): Promise<NextResponse | null> {
  if (isPublicPath(request.nextUrl.pathname)) return null;
  const token = request.cookies.get(cookieName)?.value;
  if (!token || tokenExpired(token, now)) return redirectToLogin(request, cookieName);
  const checkedAt = verified.get(token);
  if (checkedAt !== undefined && now - checkedAt < CHECK_TTL_MS) return null;
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/auth/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (response.status === 401) { verified.delete(token); return redirectToLogin(request, cookieName); }
    if (response.ok) { if (verified.size > 500) verified.clear(); verified.set(token, now); }
  } catch { /* API unreachable: fail open, every API call is authenticated anyway */ }
  return null;
}
