import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

for (const [requested, expected, warning] of [
  ['order-b', 'order-b', false],
  ['paid', '', true],
  ['missing', '', true],
]) {
  test(`cash selects only an available unpaid requested order: ${requested}`, async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: `?orderId=${requested}` } } });
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
    t.mock.method(React, 'useCallback', callback => callback);
    t.mock.method(React, 'useMemo', callback => callback());
    let mounted = false;
    t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
    t.mock.method(globalThis, 'fetch', async url => {
      const orders = [
        { id: 'order-a', code: 'A', status: 'OPEN', total: 10, payments: [], items: [] },
        { id: 'order-b', code: 'B', status: 'READY', total: 20, payments: [], items: [] },
        { id: 'paid', code: 'C', status: 'COMPLETED', total: 10, payments: [{ amount: 10 }], items: [] },
      ];
      const items = String(url).includes('/orders?') ? orders : [];
      return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'Content-Type': 'application/json' } });
    });
    const { default: CashPage } = await import('./page.tsx');
    const render = () => { cursor = 0; return CashPage(); };
    render();
    await new Promise(resolve => setImmediate(resolve));
    const tree = render();
    const paymentSelect = elements(tree, element => element.type === 'select' && elements(element, child => child.type === 'option' && child.props.value === 'order-b').length > 0)[0];
    assert.equal(paymentSelect.props.value, expected);
    assert.equal(elements(tree, element => typeof element.props.message === 'string' && element.props.message.includes('Pedido indisponível')).length > 0, warning);
  });
}
