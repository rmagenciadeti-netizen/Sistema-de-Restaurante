import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('categories can be created and renamed', async t => {
  const state = [], refs = [];
  let cursor = 0, refCursor = 0, effects = 0;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useRef', value => { const index = refCursor++; return refs[index] ?? (refs[index] = { current: value }); });
  t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });
  const requests = [];
  let items = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method) {
      const body = JSON.parse(options.body);
      requests.push({ path: String(url), method: options.method, body });
      items = [{ id: 'category-a', name: body.name }];
      return new Response(JSON.stringify(items[0]), { status: options.method === 'POST' ? 201 : 200 });
    }
    return new Response(JSON.stringify({ items, total: items.length }));
  });
  const { default: CategoriesPage } = await import('./page.tsx');
  const render = () => { cursor = 0; refCursor = 0; return CategoriesPage(); };
  render(); await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  elements(tree, element => element.props.label === 'Nome')[0].props.onChange({ target: { value: ' Bebidas ' } });
  tree = render();
  await elements(tree, element => element.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(requests[0].body, { name: 'Bebidas' });
  tree = render();
  elements(tree, element => element.type === 'button' && element.props.children === 'Editar')[0].props.onClick();
  tree = render();
  elements(tree, element => element.props.label === 'Nome')[0].props.onChange({ target: { value: 'Sucos' } });
  tree = render();
  await elements(tree, element => element.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].path, '/api-proxy/products/categories/category-a');
  assert.deepEqual(requests[1].body, { name: 'Sucos' });
});
