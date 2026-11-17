import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { guardSession, isPublicPath, tokenExpired } from './session-guard.ts';

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const now = 1_800_000_000_000;
const valid = jwt(now / 1000 + 3600);
const request = (path, token) => new NextRequest(`http://localhost:3000${path}`, token ? { headers: { cookie: `rm_restaurant_token=${token}` } } : {});
const opts = (fetchImpl) => ({ cookieName: 'rm_restaurant_token', apiUrl: 'http://api/api/v1', fetchImpl, now });

test('public paths pass; protected pages without a session get a 307 to /login and the cookie is cleared', async () => {
  for (const path of ['/login', '/forgot-password', '/reset-password/abc', '/loja/meu-restaurante', '/m/token']) assert.equal(await guardSession(request(path), opts(async () => { throw new Error('no call'); })), null);
  assert.ok(!isPublicPath('/downloads') && !isPublicPath('/login-evil'));
  const response = await guardSession(request('/downloads'), opts(async () => { throw new Error('no call'); }));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'http://localhost:3000/login');
  const forwarded = await guardSession(new NextRequest('http://localhost:3000/downloads', { headers: { host: 'localhost:3000', 'x-forwarded-host': 'app-3000.app.github.dev', 'x-forwarded-proto': 'https' } }), opts(async () => { throw new Error('no call'); }));
  assert.equal(forwarded.headers.get('location'), 'https://app-3000.app.github.dev/login');
  assert.match(response.headers.get('set-cookie'), /rm_restaurant_token=;.*Max-Age=0/i);
});

test('expired or malformed tokens are redirected without calling the API', async () => {
  assert.ok(tokenExpired(jwt(now / 1000 - 1), now) && tokenExpired('garbage', now) && !tokenExpired(valid, now));
  for (const token of [jwt(now / 1000 - 10), 'garbage']) {
    const response = await guardSession(request('/downloads', token), opts(async () => { throw new Error('no call'); }));
    assert.equal(response.status, 307);
  }
});

test('the API decides revoked sessions (401 -> redirect), valid ones continue and are cached, outages fail open', async () => {
  const token = jwt(now / 1000 + 7200);
  assert.equal((await guardSession(request('/dashboard', token), opts(async () => new Response('{}', { status: 401 })))).status, 307);
  let calls = 0;
  const ok = async (url, init) => { calls += 1; assert.equal(url, 'http://api/api/v1/auth/me'); assert.equal(init.headers.authorization, `Bearer ${valid}`); return new Response('{}', { status: 200 }); };
  assert.equal(await guardSession(request('/dashboard', valid), opts(ok)), null);
  assert.equal(await guardSession(request('/orders', valid), opts(ok)), null);
  assert.equal(calls, 1);
  assert.equal(await guardSession(request('/dashboard', jwt(now / 1000 + 9000)), opts(async () => { throw new Error('down'); })), null);
});
