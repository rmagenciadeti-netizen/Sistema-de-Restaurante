import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

test('PDV sends the selected service fee choice for table orders', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?tableId=table-a' } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  t.after(() => previousWindow ? Object.defineProperty(globalThis, 'window', previousWindow) : delete globalThis.window);
  t.after(() => previousStorage ? Object.defineProperty(globalThis, 'localStorage', previousStorage) : delete globalThis.localStorage);
  const state = [];
  let cursor = 0;
  const refs = [];
  let refCursor = 0;
  t.mock.method(React, 'useState', initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  t.mock.method(React, 'useRef', value => {
    const index = refCursor++;
    return refs[index] ?? (refs[index] = { current: value });
  });
  let effects = 0;
  t.mock.method(React, 'useEffect', effect => { if (effects++ < 2) effect(); });

  const requests = [];
  let tableError = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') requests.push(JSON.parse(options.body));
    const path = String(url);
    if (path.endsWith('/tables') && tableError) {
      return new Response(JSON.stringify({ message: 'Falha ao carregar mesas' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const payload = path.includes('/composition')
      ? { id: 'product', name: 'Produto', isCombo: false, comboComponents: [], modifierGroups: [] }
      : path.endsWith('/units')
        ? { items: [{ id: 'unit-a', name: 'A', status: 'ACTIVE' }, { id: 'unit-b', name: 'B', status: 'ACTIVE' }], total: 2 }
        : path.endsWith('/tables')
          ? { items: [{ id: 'table-a', unitId: 'unit-a', label: '1', seats: 4, active: true }, { id: 'table-b', unitId: 'unit-b', label: '2', seats: 4, active: true }], total: 2 }
          : path.endsWith('/products')
            ? { items: [{ id: 'product', name: 'Hambúrguer', code: 'H01', price: 10, active: true }, { id: 'drink', name: 'Suco', code: 'B02', price: 5, active: true }], total: 2 }
          : { items: [], total: 0 };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const { default: OrdersPage } = await import('./page.tsx');
  const render = () => { cursor = 0; refCursor = 0; return OrdersPage(); };
  const serviceFee = tree => elements(tree, element => element.props.label === 'Cobrar taxa de serviço')[0];
  let tree = render();
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  const field = label => elements(tree, element => element.props.label === label)[0];
  assert.equal(field('Unidade').props.value, 'unit-a', 'table link selects its unit');
  assert.equal(field('Mesa').props.value, 'table-a', 'table link selects the requested table');
  field('Buscar produtos').props.onChange({ target: { value: 'b02' } });
  tree = render();
  const productCards = elements(tree, element => element.type === 'button' && 'aria-pressed' in element.props);
  assert.equal(productCards.length, 1, 'search filters products by code');
  productCards[0].props.onClick();
  tree = render();
  assert.equal(elements(tree, element => element.type === 'select')[1].props.value, 'drink', 'selecting a product card updates the order');
  elements(tree, element => element.type === 'select')[0].props.onChange({ target: { value: 'POS' } });
  tree = render();
  assert.equal(serviceFee(tree), undefined, 'fee choice is not shown for other channels');

  const selects = elements(tree, element => element.type === 'select');
  selects[0].props.onChange({ target: { value: 'TABLE' } });
  selects[1].props.onChange({ target: { value: 'product' } });
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(serviceFee(tree).props.checked, true);
  field('Unidade').props.onChange({ target: { value: '' } });
  tree = render();

  const submit = async () => {
    const form = elements(tree, element => element.type === 'form')[0];
    await form.props.onSubmit({ preventDefault() {} });
  };
  await submit();
  assert.equal(requests.length, 0, 'a table order requires a unit');

  field('Unidade').props.onChange({ target: { value: 'unit-a' } });
  tree = render();
  assert.deepEqual(elements(field('Mesa'), element => element.type === 'option').map(option => option.props.value), ['', 'table-a']);
  field('Mesa').props.onChange({ target: { value: 'table-a' } });
  tree = render();
  field('Unidade').props.onChange({ target: { value: 'unit-b' } });
  tree = render();
  assert.equal(field('Mesa').props.value, '', 'changing units clears the previous table');
  assert.deepEqual(elements(field('Mesa'), element => element.type === 'option').map(option => option.props.value), ['', 'table-b']);

  await submit();
  assert.equal(requests[0].applyServiceFee, true);
  assert.equal(requests[0].unitId, 'unit-b');
  assert.equal(requests[0].tableId, undefined);

  tree = render();
  serviceFee(tree).props.onChange({ target: { checked: false } });
  tree = render();
  assert.equal(serviceFee(tree).props.checked, false);
  await submit();
  assert.equal(requests[1].applyServiceFee, false);
  assert.equal(requests[1].unitId, 'unit-b');
  assert.equal(serviceFee(render()).props.checked, true, 'the next order returns to the default');

  tableError = true;
  tree = render();
  await submit();
  assert.ok(elements(render(), element => element.props.message === 'Falha ao carregar mesas').length);
});
