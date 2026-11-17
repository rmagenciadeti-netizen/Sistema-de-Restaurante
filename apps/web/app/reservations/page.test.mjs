import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('only seated reservations with an available table can start an order', async t => {
  const state = [];
  let cursor = 0, effects = 0;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useRef', value => ({ current: value }));
  t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url);
    const items = path.endsWith('/tables') ? [{ id: 'active', unitId: 'unit', label: '1', seats: 4, active: true }, { id: 'inactive', unitId: 'unit', label: '2', seats: 4, active: false }]
      : path.endsWith('/units') ? [{ id: 'unit', name: 'Unidade', status: 'ACTIVE' }]
        : path.endsWith('/reservations') ? [
          { id: 'one', tableId: 'active', status: 'SEATED', customerName: 'Cliente', partySize: 2, reservedAt: '2026-01-01T12:00:00Z' },
          { id: 'two', tableId: 'active', status: 'CONFIRMED', customerName: 'Cliente', partySize: 2, reservedAt: '2026-01-01T12:00:00Z' },
          { id: 'three', tableId: 'inactive', status: 'SEATED', customerName: 'Cliente', partySize: 2, reservedAt: '2026-01-01T12:00:00Z' },
        ] : [];
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'Content-Type': 'application/json' } });
  });
  const { default: ReservationsPage } = await import('./page.tsx');
  const render = () => { cursor = 0; return ReservationsPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  const links = elements(render(), element => typeof element.props.href === 'string' && element.props.href.startsWith('/orders?tableId='));
  assert.deepEqual(links.map(link => link.props.href), ['/orders?tableId=active']);
});
