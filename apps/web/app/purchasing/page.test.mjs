import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

for (const [requested, expected] of [['ingredient-a', 'ingredient-a'], ['missing', '']]) {
  test(`purchasing preselects only accessible ingredients: ${requested}`, async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: `?ingredientId=${requested}` } } });
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
    t.mock.method(React, 'useRef', value => {
      const index = refCursor++;
      return refs[index] ?? (refs[index] = { current: value });
    });
    t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });
    t.mock.method(globalThis, 'fetch', async url => {
      const items = String(url).endsWith('/inventory/ingredients')
        ? [{ id: 'ingredient-a', name: 'Farinha', unitOfMeasure: 'kg', currentStock: 1 }, { id: 'ingredient-b', name: 'Queijo', unitOfMeasure: 'kg', currentStock: 2 }]
        : [];
      return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'Content-Type': 'application/json' } });
    });
    const { default: PurchasingPage } = await import('./page.tsx');
    const render = () => { cursor = 0; refCursor = 0; return PurchasingPage(); };
    render();
    await new Promise(resolve => setImmediate(resolve));
    let tree = render();
    const ingredientField = () => elements(tree, element => element.props.label === 'Ingrediente' && element.props['aria-label'] === 'Ingrediente')[0];
    assert.equal(ingredientField().props.value, expected);
    assert.equal(elements(tree, element => typeof element.props.message === 'string' && element.props.message.includes('Ingrediente indisponível')).length > 0, !expected);
    ingredientField().props.onChange({ target: { value: 'ingredient-b' } });
    tree = render();
    await elements(tree, element => element.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    tree = render();
    assert.equal(ingredientField().props.value, 'ingredient-b', 'refresh must not override a manual selection');
  });
}
