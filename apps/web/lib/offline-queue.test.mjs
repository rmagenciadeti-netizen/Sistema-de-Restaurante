import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure, createOfflineQueue, newRequestKey } from './offline-queue.ts';

const memory = () => {
  const map = new Map();
  return { map, put: async entry => { map.set(entry.key, entry); }, all: async () => [...map.values()], remove: async key => { map.delete(key); } };
};
const apiError = status => Object.assign(new Error(`status ${status}`), { status });

test('request keys satisfy the API format and are unique', () => {
  const keys = new Set(Array.from({ length: 50 }, newRequestKey));
  assert.equal(keys.size, 50);
  for (const key of keys) assert.match(key, /^[\w-]{8,64}$/);
});

test('failures: network and transient statuses retry, definitive 4xx answers block', () => {
  assert.equal(classifyFailure(new TypeError('fetch failed')), 'retry');
  for (const status of [401, 408, 429, 500, 503]) assert.equal(classifyFailure(apiError(status)), 'retry', String(status));
  for (const status of [400, 403, 404, 409, 422]) assert.equal(classifyFailure(apiError(status)), 'blocked', String(status));
});

test('flush sends in order with the idempotency key and removes what was delivered', async () => {
  const store = memory(); const queue = createOfflineQueue(store);
  const first = await queue.enqueue({ tenantId: 't1', body: { channel: 'POS' }, label: 'Venda 1' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await queue.enqueue({ tenantId: 't1', body: { channel: 'TAKEAWAY' }, label: 'Venda 2' });
  assert.equal(first.body.clientRequestId, first.key);
  const sent = [];
  const summary = await queue.flush('t1', async body => { sent.push(body.clientRequestId); });
  assert.deepEqual(sent, [first.key, second.key]);
  assert.deepEqual(summary, { sent: 2, duplicates: 0, blocked: 0, remaining: 0, stopped: false });
  assert.equal(store.map.size, 0);
});

test('a server that already had the order answers duplicate and the entry is still cleared', async () => {
  const queue = createOfflineQueue(memory());
  await queue.enqueue({ tenantId: 't1', body: {}, label: 'x' });
  assert.deepEqual(await queue.flush('t1', async () => ({ duplicate: true })), { sent: 0, duplicates: 1, blocked: 0, remaining: 0, stopped: false });
});

test('a lost connection stops the flush and keeps every unsent order', async () => {
  const store = memory(); const queue = createOfflineQueue(store);
  await queue.enqueue({ tenantId: 't1', body: {}, label: 'a', key: 'order-aaaaaaaa' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await queue.enqueue({ tenantId: 't1', body: {}, label: 'b', key: 'order-bbbbbbbb' });
  let calls = 0;
  const summary = await queue.flush('t1', async () => { calls += 1; throw new TypeError('offline'); });
  assert.equal(calls, 1, 'does not hammer the server once it is unreachable');
  assert.deepEqual([summary.sent, summary.remaining, summary.stopped], [0, 2, true]);
  assert.equal(store.map.get('order-aaaaaaaa').attempts, 1);
});

test('a rejected order is blocked for review without stopping the others, and can be retried or discarded', async () => {
  const store = memory(); const queue = createOfflineQueue(store);
  await queue.enqueue({ tenantId: 't1', body: { bad: true }, label: 'bad', key: 'order-bad00001' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await queue.enqueue({ tenantId: 't1', body: { bad: false }, label: 'good', key: 'order-good0001' });
  const send = async body => { if (body.bad) throw apiError(400); };
  const summary = await queue.flush('t1', send);
  assert.deepEqual([summary.sent, summary.blocked, summary.remaining, summary.stopped], [1, 1, 1, false]);
  assert.ok(store.map.get('order-bad00001').error);
  assert.deepEqual((await queue.flush('t1', send)).blocked, 1, 'blocked entries are not resent automatically');
  await queue.retry('order-bad00001');
  assert.equal(store.map.get('order-bad00001').error, undefined);
  await queue.discard('order-bad00001');
  assert.equal(store.map.size, 0);
});

test('orders of another restaurant are never sent by the current user', async () => {
  const queue = createOfflineQueue(memory());
  await queue.enqueue({ tenantId: 'other', body: {}, label: 'foreign' });
  let calls = 0;
  const summary = await queue.flush('mine', async () => { calls += 1; });
  assert.equal(calls, 0);
  assert.equal(summary.remaining, 0);
  assert.equal((await queue.pending('other')).length, 1, 'kept for its own restaurant');
});

test('malformed keys are rejected before reaching the device storage', async () => {
  await assert.rejects(createOfflineQueue(memory()).enqueue({ tenantId: 't', body: {}, label: 'x', key: 'short' }), /Invalid request key/);
});
