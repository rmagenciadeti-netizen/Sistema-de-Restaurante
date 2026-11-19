import assert from 'node:assert/strict';
import test from 'node:test';
import { resetFetchCache, wrapFetch, fetchCacheStats } from './fetch-cache.ts';

let calls = [];
const original = async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); await new Promise(resolve => setTimeout(resolve, 10)); return new Response(JSON.stringify({ n: calls.length }), { status: 200 }); };
const f = wrapFetch(original, 'http://x');
const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });

test('simultaneous identical GETs share one request and each caller can read its own body', async () => {
  resetFetchCache(); calls = [];
  const [a, b, c] = await Promise.all([f('/api-proxy/orders?pageSize=100', auth('t')), f('/api-proxy/orders?pageSize=100', auth('t')), f('/api-proxy/orders?pageSize=100', auth('t'))]);
  assert.equal(calls.length, 1); assert.deepEqual([await a.json(), await b.json(), await c.json()], [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.equal(fetchCacheStats.deduplicated, 2);
  await f('/api-proxy/orders?pageSize=100', auth('t')); assert.equal(calls.length, 2, 'orders/cash/stock data is never reused after the request finished');
});

test('small reference endpoints are reused briefly, per user, and a write clears them', async () => {
  resetFetchCache(); calls = [];
  await f('/api-proxy/settings', auth('u1')); await f('/api-proxy/settings', auth('u1')); assert.equal(calls.length, 1, 'second call reused');
  await f('/api-proxy/settings', auth('u2')); assert.equal(calls.length, 2, 'another user never receives it');
  await f('/api-proxy/settings/hours', { method: 'PUT', ...auth('u1') }); await f('/api-proxy/settings', auth('u1'));
  assert.equal(calls.length, 4, 'after a successful write the next read goes to the network');
  assert.equal(await (await f('/api-proxy/settings', auth('u1'))).json().then(x => typeof x.n), 'number');
});

test('other URLs and aborted/forced requests are untouched', async () => {
  resetFetchCache(); calls = [];
  await f('/somewhere/else', {}); await f('/somewhere/else', {}); assert.equal(calls.length, 2);
  const controller = new AbortController(); await f('/api-proxy/settings', { ...auth('u1'), signal: controller.signal }); await f('/api-proxy/settings', { ...auth('u1'), signal: controller.signal }); assert.equal(calls.length, 4);
});

test('JSON GETs are revalidated with If-None-Match: a 304 reuses the last body, a changed ETag brings the new one', async () => {
  resetFetchCache(); const seen = []; let version = 1;
  const server = async (url, init) => {
    const sent = new Headers(init?.headers).get('if-none-match'); seen.push(sent);
    const etag = `W/"v${version}"`;
    if (sent === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json', etag } });
  };
  const g = wrapFetch(server, 'http://x');
  assert.deepEqual(await (await g('/api-proxy/orders', auth('t'))).json(), { version: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await (await g('/api-proxy/orders', auth('t'))).json(), { version: 1 }, 'body rebuilt from the 304');
  assert.equal(fetchCacheStats.revalidated, 1);
  version = 2; await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await (await g('/api-proxy/orders', auth('t'))).json(), { version: 2 }, 'a change is never hidden');
  assert.deepEqual(seen, [null, 'W/"v1"', 'W/"v1"']);
  assert.equal(await g('/api-proxy/orders', auth('other')).then(r => r.json()).then(x => x.version), 2);
  assert.equal(seen[3], null, 'another user never sends the first user\'s validator');
});
