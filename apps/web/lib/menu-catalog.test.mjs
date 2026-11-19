import assert from 'node:assert/strict';
import test from 'node:test';
import { aiDomainOfHref, hrefVisible, menuCatalog, menuGroups } from './menu-catalog.ts';

test('"Integração e Migração" is a master-only group that points at the migration screen', () => {
  const group = menuGroups.find(item => item.title === 'Integração e Migração');
  assert.ok(group, 'group exists');
  assert.deepEqual(group.items.map(item => item.href), ['/migrations']);
  assert.ok(group.items.every(item => item.masterOnly), 'every item is restricted to the Painel Admin');
  assert.equal(menuGroups.filter(item => item.items.some(entry => entry.href === '/migrations')).length, 1, 'listed exactly once');
});

test('restaurant menus never offer the migration screen', () => {
  assert.equal(menuCatalog.some(item => item.href.startsWith('/migrations')), false);
  const restaurantVisible = menuGroups.flatMap(group => group.items.filter(item => !item.masterOnly));
  assert.equal(restaurantVisible.some(item => item.href.startsWith('/migrations')), false);
});

test('RM Intelligence entries: one central + ten specialists, shown only for what the server lists for the profile', () => {
  const group = menuGroups.find(item => item.title === 'RM INTELLIGENCE');
  assert.deepEqual(group.items.map(item => item.href).filter(href => href.startsWith('/ai')), ['/ai', '/ai/finance', '/ai/stock', '/ai/profit', '/ai/sales', '/ai/purchasing', '/ai/customers', '/ai/delivery', '/ai/production', '/ai/waste', '/ai/management']);
  assert.equal(menuGroups.filter(item => /intell?ig/i.test(item.title)).length, 1, 'a single RM Intelligence module, no duplicated group');
  assert.equal(new Set(group.items.map(entry => entry.href)).size, group.items.length, 'no entry is listed twice inside RM Intelligence');
  const elsewhere = menuGroups.filter(item => item !== group).flatMap(item => item.items.map(entry => entry.href));
  assert.equal(group.items.filter(entry => elsewhere.includes(entry.href)).length, 0, 'RM Intelligence entries are not repeated in other groups');
  assert.equal(aiDomainOfHref('/ai'), 'central'); assert.equal(aiDomainOfHref('/ai/stock'), 'stock'); assert.equal(aiDomainOfHref('/airline'), null);
  const base = { enabledModules: null, role: 'KITCHEN' };
  assert.equal(hrefVisible('/ai/stock', { ...base, aiDomains: ['stock', 'production'] }), true);
  assert.equal(hrefVisible('/ai/finance', { ...base, aiDomains: ['stock', 'production'] }), false, 'no link that ends in a predictable 403');
  assert.equal(hrefVisible('/ai', { ...base, aiDomains: [] }), false);
  assert.equal(hrefVisible('/ai/stock', { ...base, aiDomains: null }), false, 'hidden while loading');
});

test('licence and permission are separate checks and nothing flashes while they load', () => {
  const loading = { enabledModules: undefined, role: 'ADMIN', aiDomains: null };
  assert.equal(hrefVisible('/profit', loading), false, 'a licensed-module screen is not offered before the licence is known');
  assert.equal(hrefVisible('/dashboard', loading), true, 'core screens stay');
  assert.equal(hrefVisible('/profit', { enabledModules: ['profit'], role: 'ADMIN', aiDomains: [] }), true);
  assert.equal(hrefVisible('/profit', { enabledModules: ['pos'], role: 'ADMIN', aiDomains: [] }), false, 'not contracted');
  assert.equal(hrefVisible('/profit', { enabledModules: ['profit'], role: 'CASHIER', aiDomains: [] }), false, 'contracted but the role cannot use it');
  assert.equal(hrefVisible('/intelligence?tab=stock', { enabledModules: null, role: 'KITCHEN', aiDomains: [] }), false);
  assert.equal(hrefVisible('/intelligence?tab=stock', { enabledModules: null, role: 'FINANCE', aiDomains: [] }), true, 'no licence row = unrestricted');
});
