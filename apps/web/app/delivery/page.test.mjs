import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('delivery groups deliveries by status and no longer offers a manual new-delivery form', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '' } } });
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
  const order = { id: 'order-a', code: 'A1', channel: 'DELIVERY', status: 'READY', customerName: 'Cliente', total: 15, items: [], createdAt: '2026-01-01T12:00:00Z' };
  const jobs = [{ id: 'job-a', orderId: order.id, status: 'PENDING', createdAt: order.createdAt, order }];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url);
    if (path.endsWith('/delivery/summary')) return new Response(JSON.stringify({ openNow: 1, total: 1, delivered: 0, cancelled: 0, averageMinutes: null, feesCollected: 0, deliveredRevenue: 0, byCourier: [] }));
    return new Response(JSON.stringify({ items: path.endsWith('/delivery') ? jobs : [], total: 1 }));
  });
  const { default: DeliveryPage } = await import('./page.tsx');
  const render = () => { cursor = 0; refCursor = 0; return DeliveryPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  const tree = render();
  assert.equal(elements(tree, element => element.type === 'form' && element.props.onSubmit && elements(element, child => child.props.label === 'Pedido de delivery').length > 0).length, 0, 'deliveries are created from the order board');
  assert.equal(elements(tree, element => element.props.id === 'nova-entrega').length, 0);
  const pending = elements(tree, element => element.type === 'section' && element.props.children?.[0]?.props?.children?.[0] === 'Pendente')[0];
  assert.ok(pending);
  assert.equal(elements(pending, element => element.props.href === '/cash?orderId=order-a#pagamento').length, 1);
});
