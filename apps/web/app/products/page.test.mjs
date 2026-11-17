import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('catalog search filters products without changing their stock links', async t => {
  const state = [];
  let cursor = 0, mounted = false;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
  t.mock.method(globalThis, 'fetch', async url => {
    const items = String(url).includes('/products?')
      ? [{ id: 'a', name: 'Hambúrguer', code: 'H01', price: 20, active: true, sector: { name: 'Cozinha' } }, { id: 'b', name: 'Suco', code: 'B02', price: 8, active: true }]
      : [];
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'Content-Type': 'application/json' } });
  });
  const { default: ProductsPage } = await import('./page.tsx');
  const render = () => { cursor = 0; return ProductsPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  elements(tree, element => element.props.label === 'Pesquisar nesta página')[0].props.onChange({ target: { value: 'cozinha' } });
  tree = render();
  const links = elements(tree, element => typeof element.props.href === 'string' && element.props.href.startsWith('/inventory?productId='));
  assert.deepEqual(links.map(link => link.props.href), ['/inventory?productId=a#ficha-tecnica']);
});

test('bulk prices validate, show conflicts and submit the selected prices', async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
    t.after(() => previousWindow ? Object.defineProperty(globalThis, 'window', previousWindow) : delete globalThis.window);
    t.after(() => previousStorage ? Object.defineProperty(globalThis, 'localStorage', previousStorage) : delete globalThis.localStorage);
    const state = [];
    let cursor = 0, mounted = false;
    t.mock.method(React, 'useState', initial => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    });

    t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (options.method === 'PATCH') {
        requests.push(JSON.parse(options.body));
        return new Response(JSON.stringify(requests.length === 1 ? { message: 'Preço alterado por outro usuário' } : { updated: 2 }), { status: requests.length === 1 ? 409 : 200 });
      }
      const items = String(url).includes('/products?')
        ? [{ id: 'a', name: 'Hambúrguer', price: '20.00', active: true }, { id: 'b', name: 'Suco', price: '8.50', active: true }]
        : [];
      return new Response(JSON.stringify({ items, total: items.length }));
    });
    const { default: ProductsPage } = await import('./page.tsx');
    const render = () => { cursor = 0; return ProductsPage(); };
    render();
    await new Promise(resolve => setImmediate(resolve));
    let tree = render();
    for (const checkbox of elements(tree, element => element.type === 'input' && element.props.type === 'checkbox')) checkbox.props.onChange({ target: { checked: true } });
    tree = render();
    const field = label => elements(tree, element => element.props.label === label)[0];
    field('Percentual (%)').props.onChange({ target: { value: '6,25' } });
    tree = render();
    elements(tree, element => element.type === 'button' && element.props.children === 'Calcular prévia')[0].props.onClick();
    tree = render();
    assert.equal(field('Novo preço de Hambúrguer (R$)').props.value, '21.25');
    assert.equal(field('Novo preço de Suco (R$)').props.value, '9.03');
    elements(tree, element => element.type === 'select' && element.props.value === 'increase')[0].props.onChange({ target: { value: 'decrease' } });
    field('Percentual (%)').props.onChange({ target: { value: '5' } });
    tree = render();
    elements(tree, element => element.type === 'button' && element.props.children === 'Calcular prévia')[0].props.onClick();
    tree = render();
    assert.equal(field('Novo preço de Suco (R$)').props.value, '8.08', 'percentage discounts round the final price half up');
    elements(tree, element => element.type === 'select' && element.props.value === 'decrease')[0].props.onChange({ target: { value: 'increase' } });
    field('Percentual (%)').props.onChange({ target: { value: '6,25' } });
    tree = render();
    elements(tree, element => element.type === 'button' && element.props.children === 'Calcular prévia')[0].props.onClick();
    tree = render();
    field('Novo preço de Hambúrguer (R$)').props.onChange({ target: { value: '-1' } });
    tree = render();
    const save = () => elements(tree, element => element.type === 'button' && element.props.children === 'Confirmar preços')[0].props.onClick();
    save();
    assert.equal(requests.length, 0);
    assert.ok(elements(render(), element => String(element.props.message).includes('preços válidos')).length);
    tree = render();
    field('Novo preço de Hambúrguer (R$)').props.onChange({ target: { value: '21,30' } });
    tree = render();
    await save();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[0], { items: [{ id: 'a', expectedPrice: '20.00', price: '21.30' }, { id: 'b', expectedPrice: '8.50', price: '9.03' }] });
    tree = render();
    assert.ok(elements(tree, element => element.props.message === 'Preço alterado por outro usuário').length);
    assert.equal(elements(tree, element => element.props.label === 'Novo preço de Hambúrguer (R$)').length, 1);
    await save();
    await new Promise(resolve => setImmediate(resolve));
    tree = render();
    assert.ok(elements(tree, element => element.props.message === 'Preços atualizados.').length);
    assert.equal(elements(tree, element => element.props.label === 'Novo preço de Hambúrguer (R$)').length, 0);
});

test('catalog assigns a category to an existing product', async t => {
  const state = [];
  let cursor = 0, mounted = false;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'PATCH') {
      requests.push({ path: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'a' }));
    }
    const path = String(url);
    const items = path.includes('/products?') ? [{ id: 'a', name: 'Suco', price: '8.50', active: true }] : path.endsWith('/products/categories') ? [{ id: 'category-a', name: 'Bebidas' }] : [];
    return new Response(JSON.stringify({ items, total: items.length }));
  });
  const { default: ProductsPage } = await import('./page.tsx');
  const render = () => { cursor = 0; return ProductsPage(); };
  render(); await new Promise(resolve => setImmediate(resolve));
  const tree = render();
  elements(tree, element => element.props['aria-label'] === 'Categoria de Suco')[0].props.onChange({ target: { value: 'category-a' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests[0], { path: '/api-proxy/products/a', body: { categoryId: 'category-a' } });
});
