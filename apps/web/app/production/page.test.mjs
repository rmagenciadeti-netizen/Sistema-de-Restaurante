import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement(node) ? textOf(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

test('printer and sector forms offer the printers installed in Windows', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
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
  const writes = [];
  const agents = [{ id: 'ag1', name: 'Caixa', active: true, printersReportedAt: '2026-01-01T12:00:00Z', printers: [{ name: 'EPSON TM-T20', isDefault: true }, { name: 'Microsoft Print to PDF' }] }];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url);
    if (options.method) { writes.push({ method: options.method, path: path.replace('/api-proxy', ''), body: JSON.parse(options.body) }); return new Response(JSON.stringify({ id: 'new' }), { status: 201 }); }
    const items = path.endsWith('/production/sectors') ? [{ id: 's1', name: 'Bar', sortOrder: 0, autoPrint: true, showOnKds: true, active: true }] : path.endsWith('/printing/agents') ? agents : [];
    return new Response(JSON.stringify({ items, total: items.length }));
  });
  const { default: ProductionPage } = await import('./page.tsx');
  const render = () => { cursor = 0; refCursor = 0; return ProductionPage(); };
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  const optionValues = select => elements(select, element => element.type === 'option').map(option => option.props.value);

  const sectorSelect = elements(tree, element => element.props.label === 'Impressora do setor (inclui as do Windows)')[0];
  assert.deepEqual(optionValues(sectorSelect), ['', 'w:ag1|EPSON TM-T20', 'w:ag1|Microsoft Print to PDF'], 'the sector form lists the Windows printers');

  elements(tree, element => element.type === 'button' && textOf(element) === 'Impressoras')[0].props.onClick();
  tree = render();
  const connection = elements(tree, element => element.props.label === 'Conexão')[0];
  assert.ok(optionValues(connection).includes('WINDOWS'));
  connection.props.onChange({ target: { value: 'WINDOWS' } });
  tree = render();
  assert.equal(elements(tree, element => element.props.label === 'Endereço (IP, nome compartilhado ou porta)').length, 0, 'no IP/port for Windows printers');
  const winSelect = elements(tree, element => element.props.label === 'Impressora do Windows')[0];
  assert.deepEqual(optionValues(winSelect), ['', 'ag1|EPSON TM-T20', 'ag1|Microsoft Print to PDF']);
  winSelect.props.onChange({ target: { value: 'ag1|EPSON TM-T20' } });
  tree = render();
  assert.equal(elements(tree, element => element.props.label === 'Nome')[0].props.value, 'EPSON TM-T20', 'the name defaults to the Windows printer name');
  await elements(tree, element => element.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(writes[0], { method: 'POST', path: '/printing/printers', body: { name: 'EPSON TM-T20', kind: 'KITCHEN', connectionType: 'WINDOWS', agentId: 'ag1', address: 'EPSON TM-T20', paperWidthMm: 80, sectorId: null, isPrimary: false, autoCut: true, cashDrawer: false, active: true } });
});
