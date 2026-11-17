import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('pickup ticket includes only configured top-level products', async () => {
  const { PickupTicket, pickupTicketItems } = await import('../../components/order-receipt.tsx');
  const order = { id: 'o', code: 'P-1', channel: 'POS', status: 'OPEN', total: 10, createdAt: '2026-01-01T00:00:00Z', items: [
    { id: '1', quantity: '0.5', product: { name: 'Pizza', pickupTicket: true } },
    { id: '2', quantity: 1, product: { name: 'Bebida', pickupTicket: false } },
    { id: '3', quantity: 1, parentItemId: '1', product: { name: 'Componente', pickupTicket: true } },
    { id: '4', quantity: 1, status: 'CANCELLED', product: { name: 'Item cancelado', pickupTicket: true } },
  ] };
  assert.deepEqual(pickupTicketItems(order).map(item => item.id), ['1']);
  const html = renderToStaticMarkup(React.createElement(PickupTicket, { order }));
  assert.match(html, /Ticket de retirada/);
  assert.match(html, /0\.5× Pizza/);
  assert.doesNotMatch(html, /Bebida|Componente|Item cancelado/);
});

test('quantity accepts decimal comma only when fractional quantities are enabled', async () => {
  const { parseQuantity } = await import('../../lib/quantity.ts');
  assert.equal(parseQuantity('0,375', true, 20), 0.375);
  assert.equal(parseQuantity('0,375', false, 20), null);
  for (const value of ['', '0', '0,', '0,0001', '21', '-1', '1e2']) assert.equal(parseQuantity(value, true, 20), null);
  assert.equal(parseQuantity('20', false, 20), 20);
});

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
    if (String(url).endsWith('/settings')) return new Response(JSON.stringify({ settings: { products: { defaultMarginPercent: 18 } } }));
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
  assert.equal(elements(tree, element => element.props.label === 'Margem que quero ganhar (%)')[0].props.value, '18');
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
      if (String(url).endsWith('/settings')) return new Response(JSON.stringify({ settings: { products: { defaultMarginPercent: 12 } } }));
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
    if (path.endsWith('/settings')) return new Response(JSON.stringify({ settings: { products: { defaultMarginPercent: 0 } } }));
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

test('product form persists POS, pickup, packaging and stock options', async t => {
  const state = [];
  let cursor = 0, mounted = false, created;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useEffect', effect => { if (!mounted) { mounted = true; effect(); } });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url);
    if (options.method === 'POST') {
      created = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'new-product' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path.endsWith('/settings')) return new Response(JSON.stringify({ settings: { products: { defaultMarginPercent: 0 } } }));
    return new Response(JSON.stringify({ items: [], total: 0 }), { headers: { 'Content-Type': 'application/json' } });
  });
  const { default: ProductsPage } = await import('./page.tsx');
  const render = () => { cursor = 0; return ProductsPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  const field = label => elements(tree, element => element.props.label === label)[0];
  field('Nome').props.onChange({ target: { value: 'Produto variável' } });
  tree = render();
  field('Preço de venda (R$)').props.onChange({ target: { value: '12.50' } });
  tree = render();
  elements(tree, element => element.props.label === 'Preço livre (UN) — permite informar o preço no PDV')[0].props.onChange({ target: { checked: true } });
  tree = render();
  elements(tree, element => element.props.label === 'Sempre mostrar descrição no PDV')[0].props.onChange({ target: { checked: true } });
  tree = render();
  elements(tree, element => element.props.label === 'Ticket de retirada para este produto')[0].props.onChange({ target: { checked: true } });
  tree = render();
  elements(tree, element => element.props.label === 'Habilitar embalagem')[0].props.onChange({ target: { checked: true } });
  tree = render();
  field('Preço da embalagem (R$)').props.onChange({ target: { value: '1.25' } });
  tree = render();
  elements(tree, element => element.props.label === 'Controlar saldo')[0].props.onChange({ target: { checked: true } });
  tree = render();
  field('Estoque inicial').props.onChange({ target: { value: '4.25' } });
  tree = render();
  await elements(tree, element => element.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(created.allowFreePrice, true);
  assert.equal(created.alwaysShowDescription, true);
  assert.equal(created.pickupTicket, true);
  assert.equal(created.packagingEnabled, true);
  assert.equal(created.packagingPrice, 1.25);
  assert.equal(created.stockControlled, true);
  assert.equal(created.initialStock, 4.25);
});
