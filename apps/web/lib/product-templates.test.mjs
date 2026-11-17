import assert from 'node:assert/strict';
import test from 'node:test';

test('product templates are consistent and attach only missing groups', async t => {
  const { productTemplates, attachTemplateGroups } = await import('./product-templates.ts');
  const names = new Set();
  for (const template of productTemplates) for (const group of template.groups) {
    assert.ok(group.minSelect <= group.maxSelect && group.maxSelect <= group.options.length + 50, group.name);
    assert.equal(new Set(group.options).size, group.options.length, `${group.name}: duplicate options`);
    assert.ok(group.minSelect <= group.options.length, group.name);
    assert.equal(names.has(group.name.toLowerCase()), false, `${group.name} is shared by two templates`);
    names.add(group.name.toLowerCase());
  }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push([init.method ?? 'GET', String(url).replace('/api-proxy', ''), init.body ? JSON.parse(init.body) : undefined]);
    const path = String(url);
    if (path.endsWith('/catalog/modifier-groups') && !init.method) return Response.json({ items: [{ id: 'g-size', name: 'tamanho da pizza' }], total: 1 });
    if (path.endsWith('/catalog/modifier-groups')) return Response.json({ id: `new-${calls.length}` }, { status: 201 });
    return Response.json({});
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  await attachTemplateGroups('p1', productTemplates.find(item => item.key === 'pizza').groups);
  const created = calls.filter(([method, path]) => method === 'POST' && path === '/catalog/modifier-groups');
  assert.equal(created.length, 2, 'the existing size group is reused case-insensitively');
  const put = calls.find(([method]) => method === 'PUT');
  assert.equal(put[1], '/catalog/products/p1/modifier-groups');
  assert.equal(put[2].groupIds.length, 3);
  calls.length = 0;
  await attachTemplateGroups('p2', []);
  assert.equal(calls.length, 0, 'templates without groups make no requests');
});
