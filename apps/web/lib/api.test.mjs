import assert from 'node:assert/strict';
import test from 'node:test';

function setup(pathname, token = 'tok') {
  const store = new Map(token ? [['rm_restaurant_token', token], ['rm_restaurant_user', '{}']] : []);
  const replaced = [];
  globalThis.window = { location: { pathname, replace: url => replaced.push(url) } };
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, removeItem: key => store.delete(key), setItem: (key, value) => store.set(key, value) };
  globalThis.document = { cookie: 'rm_restaurant_token=tok' };
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Invalid or expired token' }), { status: 401 });
  return { store, replaced, document: globalThis.document };
}

test('401 on the login screen or on public calls never redirects', async () => {
  const { api, publicApi } = await import('./api.ts');
  const login = setup('/login');
  await assert.rejects(api('/auth/me'), { status: 401 });
  assert.deepEqual(login.replaced, []);
  const page = setup('/downloads');
  await assert.rejects(publicApi('/auth/login', { method: 'POST', body: '{}' }), { status: 401 });
  assert.deepEqual(page.replaced, []);
  assert.equal(page.store.get('rm_restaurant_token'), 'tok');
});

test('401 on an authenticated call clears the session and redirects to /login once', async () => {
  const { api } = await import('./api.ts');
  const { store, replaced, document } = setup('/downloads');
  await assert.rejects(api('/auth/me'), { status: 401 });
  await assert.rejects(api('/settings'), { status: 401 });
  assert.deepEqual(replaced, ['/login']);
  assert.equal(store.size, 0);
  assert.match(document.cookie, /rm_restaurant_token=;.*Max-Age=0/);
});
