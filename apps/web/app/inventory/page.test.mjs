import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

for (const [requested, expected, warning] of [
  ['product-a', 'product-a', false],
  ['inactive', '', true],
]) {
  test(`inventory opens recipe only for an available active product: ${requested}`, async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: `?productId=${requested}` } } });
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
    t.mock.method(React, 'useRef', value => ({ current: value }));
    let mounted = false;
    t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
      calls.push(String(url));
      const payload = String(url).includes('/recipes/')
        ? { yield: 2, ingredients: [], notes: 'Receita existente' }
        : { items: String(url).endsWith('/products') ? [
          { id: 'product-a', name: 'Produto A', active: true },
          { id: 'inactive', name: 'Inativo', active: false },
        ] : [] };
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    });
    const { default: InventoryPage } = await import('./page.tsx');
    const render = () => { cursor = 0; return InventoryPage(); };
    render();
    await new Promise(resolve => setImmediate(resolve));
    const tree = render();
    const productSelect = elements(tree, element => element.type === 'select' && elements(element, child => child.type === 'option' && child.props.value === 'product-a').length > 0)[0];
    assert.equal(productSelect.props.value, expected);
    assert.equal(calls.some(url => url.endsWith(`/inventory/recipes/${requested}`)), !warning);
    assert.equal(elements(tree, element => typeof element.props.message === 'string' && element.props.message.includes('Produto indisponível')).length > 0, warning);
  });
}
