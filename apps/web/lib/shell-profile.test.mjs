import assert from 'node:assert/strict';
import test from 'node:test';

// The shell profile store: the menu is built from the last known data and refined silently; a transient failure never shrinks it.
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.window = globalThis;
let answers = {};
const calls = [];
globalThis.fetch = async url => {
  const path = String(url).split('/api-proxy')[1] ?? String(url);
  calls.push(path);
  const answer = answers[path];
  if (answer === 'network') throw new TypeError('network down');
  return { status: answer.status ?? 200, ok: (answer.status ?? 200) < 400, json: async () => answer.body ?? {} };
};

const { hydrateShellProfile, refreshShellProfile, getShellProfile, resetShellProfile } = await import('./shell-profile.ts');
const { userStorageKey } = await import('./api.ts');
const settings = { settings: { menuLayout: { hidden: ['/crm'] }, company: { sidebarLayout: 'COMPACT' }, hours: { mode: 'OPEN', weekly: [], timezone: 'America/Sao_Paulo' } } };
const full = () => ({
  '/auth/me': { body: { user: { tenant: { name: 'Casa Teste', license: null }, enabledModules: ['pos', 'financial'] } } },
  '/ai/domains': { body: { available: [{ key: 'sales' }, { key: 'stock' }] } },
  '/settings': { body: settings },
});

test('a cold start has no profile (placeholders), then the answers fill it once', async () => {
  storage.set(userStorageKey, JSON.stringify({ id: 'u1' })); resetShellProfile(); hydrateShellProfile();
  assert.equal(getShellProfile().ready, false); assert.equal(getShellProfile().enabledModules, undefined);
  answers = full(); await refreshShellProfile();
  const profile = getShellProfile();
  assert.deepEqual([profile.ready, profile.enabledModules, profile.aiDomains, profile.menuHidden, profile.sidebarLayout, profile.tenant?.name], [true, ['pos', 'financial'], ['sales', 'stock'], ['/crm'], 'COMPACT', 'Casa Teste']);
});

test('a reload starts from the last known profile (final menu on the first paint) and refreshes silently', async () => {
  storage.set(userStorageKey, JSON.stringify({ id: 'u1' })); resetShellProfile(); hydrateShellProfile(); answers = full(); await refreshShellProfile();
  // A page reload loses module state but keeps localStorage: a fresh instance of the store must already know the profile, without any request.
  // Memory is wiped but the cached entry is put back: that is exactly what a page reload leaves behind.
  const saved = [...storage.entries()].filter(([key]) => key.startsWith('rm_shell_profile:'));
  resetShellProfile(); for (const [key, value] of saved) storage.set(key, value);
  const requests = calls.length;
  hydrateShellProfile();
  const profile = getShellProfile();
  assert.deepEqual([profile.ready, profile.enabledModules, profile.aiDomains, profile.menuHidden], [true, ['pos', 'financial'], ['sales', 'stock'], ['/crm']]);
  assert.equal(calls.length, requests, 'hydration is local');
  const key = [...storage.keys()].find(item => item.startsWith('rm_shell_profile:'));
  assert.ok(key); assert.ok(!/token|password/i.test(storage.get(key)), 'only menu data is cached');
});

test('a transient failure keeps what was known; a definitive 403 on AI means none; another user never sees it', async () => {
  storage.set(userStorageKey, JSON.stringify({ id: 'u2' })); resetShellProfile(); hydrateShellProfile();
  answers = full(); await refreshShellProfile();
  const known = getShellProfile();
  answers = { '/auth/me': 'network', '/ai/domains': 'network', '/settings': { status: 500 } };
  const originalSetTimeout = globalThis.setTimeout; globalThis.setTimeout = fn => originalSetTimeout(fn, 0);
  try { await refreshShellProfile(); } finally { globalThis.setTimeout = originalSetTimeout; }
  const after = getShellProfile();
  assert.deepEqual([after.enabledModules, after.aiDomains, after.menuHidden], [known.enabledModules, known.aiDomains, known.menuHidden], 'nothing shrinks because the network blinked');
  answers = { ...full(), '/ai/domains': { status: 403, body: { message: 'forbidden' } } }; await refreshShellProfile();
  assert.deepEqual(getShellProfile().aiDomains, [], 'a real denial removes the specialists');
  storage.set(userStorageKey, JSON.stringify({ id: 'u3' })); hydrateShellProfile();
  assert.equal(getShellProfile().ready, false); assert.equal(getShellProfile().aiDomains, null, 'the profile of another user is not reused');
});
