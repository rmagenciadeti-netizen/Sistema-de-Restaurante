import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement(node) ? textOf(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

test('order board dispatches with a courier, prints, issues the NFC-e and opens the editor', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '' }, confirm: () => true, print: () => {} } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  t.after(() => previousWindow ? Object.defineProperty(globalThis, 'window', previousWindow) : delete globalThis.window);
  t.after(() => previousStorage ? Object.defineProperty(globalThis, 'localStorage', previousStorage) : delete globalThis.localStorage);
  const state = [];
  let cursor = 0;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  const refs = [];
  let refCursor = 0;
  t.mock.method(React, 'useRef', value => { const index = refCursor++; return refs[index] ?? (refs[index] = { current: value }); });
  // The board polls every 15 s; keep the timer from holding the test process open.
  t.mock.method(globalThis, 'setInterval', () => 0);
  let effects = 0;
  t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });

  const order = { id: 'o1', code: 'P-1', number: 7, channel: 'DELIVERY', status: 'READY', customerName: 'Ana', total: 20, subtotal: 15, createdAt: '2026-01-01T12:00:00Z', items: [{ id: 'i1', quantity: 1, product: { id: 'p1', name: 'Suco', pickupTicket: true } }], payments: [], deliveryJob: null, fiscalDocuments: [] };
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url);
    if (options.method === 'POST') { posts.push({ path, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ number: '100', series: '2' }), { status: 201 }); }
    const payload = path.endsWith('/settings') ? { settings: { ticket: { enabled: true }, printing: { paper: '80mm' }, company: {} } } : path.includes('/orders?') ? { items: [order], total: 1 } : path.includes('/couriers') ? { items: [{ id: 'c1', name: 'Zé', phone: '1199', active: true }], total: 1 } : path.includes('/fiscal/providers') ? { items: ['fakefisc'] } : { items: [], total: 0 };
    return new Response(JSON.stringify(payload));
  });
  const { default: MonitorPage } = await import('./page.tsx');
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const render = () => { cursor = 0; refCursor = 0; return MonitorPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  const button = (label, scope = tree) => elements(scope, element => element.type === 'button' && (textOf(element) === label || element.props['aria-label']?.startsWith(label)))[0];
  assert.ok(button('Imprimir pedido'), 'printer button on the order');
  assert.ok(button('Ticket de retirada'), 'pickup ticket is available for a marked delivery product');
  button('Ticket de retirada').props.onClick();
  tree = render();
  const { PickupTicket } = await import('../../components/order-receipt.tsx');
  assert.equal(elements(tree, element => element.type === PickupTicket && element.props.order.id === order.id).length, 1);
  const settingsIndex = state.findIndex(value => value?.ticket?.enabled === true);
  state[settingsIndex] = { ...state[settingsIndex], ticket: { enabled: false } };
  tree = render();
  assert.equal(button('Ticket de retirada'), undefined, 'disabled pickup tickets are hidden');
  assert.ok(button('Gerar NFC-e'), 'NFC-e button on the order');
  assert.ok(button('Mais opções do pedido'), 'three-dots menu on the order');

  await button('Saiu para entrega').props.onClick();
  assert.equal(posts.length, 0, 'a courier must be chosen first');
  const courierSelect = elements(tree, element => element.type === 'select')[0];
  assert.deepEqual(elements(courierSelect, element => element.type === 'option').map(option => option.props.value), ['', 'c1', '__manual__']);
  courierSelect.props.onChange({ target: { value: 'c1' } });
  tree = render();
  await button('Saiu para entrega').props.onClick();
  assert.deepEqual(posts[0], { path: '/api-proxy/delivery/orders/o1/dispatch', body: { courierId: 'c1' } });

  tree = render();
  await button('Gerar NFC-e').props.onClick();
  assert.deepEqual(posts[1], { path: '/api-proxy/fiscal/orders/o1/emit', body: { provider: 'fakefisc', kind: 'NFCE' } });

  tree = render();
  button('Mais opções do pedido').props.onClick();
  tree = render();
  elements(tree, element => element.props.role === 'menuitem')[0].props.onClick();
  tree = render();
  assert.equal(elements(tree, element => element.props.order?.id === 'o1' && typeof element.props.onSaved === 'function').length, 1, 'the edit dialog opens for the order');
});
