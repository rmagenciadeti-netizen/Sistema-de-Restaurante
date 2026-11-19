// Data saving at the single place every API call passes through (the browser's fetch):
//  1. identical GETs that are in flight at the same time share ONE network request (several components asking for /settings or /payments/providers on mount);
//  2. a short allow-list of small reference endpoints is reused for a few seconds, so moving between screens does not download them again;
//  3. every other JSON GET is revalidated with If-None-Match (the API already emits ETags): when nothing changed the server answers 304 with no body and the last body is reused, so the data stays always fresh but is not downloaded again;
//  4. any successful write (POST/PUT/PATCH/DELETE) empties the cache, so stock, cash, orders and permissions are never shown stale after a change.
// Memory only (never localStorage), keyed by the Authorization header, so nothing is shared between users and nothing sensitive is persisted. Financial, order and stock data are NOT in the allow-list.
const TTL_MS = 15_000;
const CACHEABLE = /\/api-proxy\/(auth\/me|ai\/domains|settings|appearance|units|payments\/providers|tef\/providers)$/;

type Entry = { master: Response; expires: number };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Response>>();
const etags = new Map<string, { etag: string; body: string; type: string }>();
const ETAG_MAX_CHARS = 512_000;
export const fetchCacheStats = { network: 0, deduplicated: 0, reused: 0, revalidated: 0 };

export function resetFetchCache() { store.clear(); inflight.clear(); etags.clear(); fetchCacheStats.revalidated = 0; fetchCacheStats.network = 0; fetchCacheStats.deduplicated = 0; fetchCacheStats.reused = 0; }

export function wrapFetch(original: typeof fetch, origin = 'http://localhost'): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/api-proxy/')) return original(input, init);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET').toUpperCase();
    if (method !== 'GET') return original(input, init).then(response => { if (response.ok) store.clear(); return response; });
    if (init?.signal || init?.cache === 'reload') return original(input, init);
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    const parsed = new URL(url, origin);
    const key = `${headers.get('authorization') ?? ''}|${parsed.pathname}${parsed.search}`;
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) { fetchCacheStats.reused++; return Promise.resolve(hit.master.clone()); }
    const running = inflight.get(key);
    if (running) { fetchCacheStats.deduplicated++; return running.then(response => response.clone()); }
    fetchCacheStats.network++;
    // The master response is never read; every caller gets its own clone.
    const known = etags.get(key);
    const send = known ? original(input, { ...init, headers: (() => { const next = new Headers(headers); next.set('If-None-Match', known.etag); return next; })() }) : original(input, init);
    const request = send
      .then(response => {
        if (response.status === 304 && known) { fetchCacheStats.revalidated++; return new Response(known.body, { status: 200, headers: { 'content-type': known.type } }); }
        const etag = response.headers.get('etag'); const type = response.headers.get('content-type') ?? '';
        if (response.ok && etag && type.includes('json')) void response.clone().text().then(body => { if (body.length <= ETAG_MAX_CHARS) etags.set(key, { etag, body, type }); }).catch(() => undefined);
        return response;
      })
      .then(response => { if (response.ok && CACHEABLE.test(parsed.pathname)) store.set(key, { master: response, expires: Date.now() + TTL_MS }); return response; })
      .finally(() => { inflight.delete(key); });
    inflight.set(key, request);
    return request.then(response => response.clone());
  }) as typeof fetch;
}

let installed = false;
export function installFetchCache() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  window.fetch = wrapFetch(window.fetch.bind(window), window.location.origin);
}
