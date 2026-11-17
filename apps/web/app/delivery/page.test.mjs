import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('delivery opens the linked order and groups deliveries by status', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?orderId=order-a' } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  t.after(() => previousWindow ? Object.defineProperty(globalThis, 'window', previousWindow) : delete globalThis.window);
  t.after(() => previousStorage ? Object.defineProperty(globalThis, 'localStorage', previousStorage) : delete globalThis.localStorage);
  const state = [], refs = [];
  let cursor = 0, refCursor = 0, effects = 0;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useRef', value => { const index = refCursor++; return refs[index] ?? (refs[index] = { current: value }); });
  t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });
  const order = { id: 'order-a', code: 'A1', channel: 'DELIVERY', status: 'OPEN', customerName: 'Cliente', total: 15, items: [], createdAt: '2026-01-01T12:00:00Z' };
  const requests = [];
  let jobs = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url);
    if (options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      jobs = [{ id: 'job-a', orderId: order.id, status: 'PENDING', createdAt: order.createdAt, order }];
      return new Response(JSON.stringify(jobs[0]), { status: 201 });
    }
    return new Response(JSON.stringify({ items: path.endsWith('/delivery') ? jobs : path.includes('/orders?') ? [order] : [], total: 1 }));
  });
  const { default: DeliveryPage } = await import('./page.tsx');
  const render = () => { cursor = 0; refCursor = 0; return DeliveryPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  assert.equal(elements(tree, element => element.props.label === 'Pedido de delivery')[0].props.value, 'order-a');
  const form = elements(tree, element => element.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(requests[0].orderId, 'order-a');
  tree = render();
  const pending = elements(tree, element => element.type === 'section' && element.props.children?.[0]?.props?.children?.[0] === 'Pendente')[0];
  assert.ok(pending);
  assert.equal(elements(pending, element => element.props.href === '/cash?orderId=order-a#pagamento').length, 1);
});
