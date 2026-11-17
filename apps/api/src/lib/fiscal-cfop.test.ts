import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationOf, natureApplies, resolveCfop } from './fiscal-cfop';

const nature = { cfop: '6102', destination: 'INTERSTATE', ufOrigin: null, ufDestination: null, taxRegime: null, active: true, direction: 'OUT' };

test('only NF-e to another state is interstate', () => {
  assert.equal(destinationOf('NFE', 'MT', 'SP'), 'INTERSTATE');
  assert.equal(destinationOf('NFE', 'MT', 'mt'), 'INTERNAL');
  assert.equal(destinationOf('NFE', 'MT', null), 'INTERNAL');
  assert.equal(destinationOf('NFCE', 'MT', 'SP'), 'INTERNAL');
});

test('natures apply only when every defined criterion matches', () => {
  const scope = { destination: 'INTERSTATE' as const, issuerUf: 'MT', recipientUf: 'SP', taxRegime: 'SIMPLES_NACIONAL' };
  assert.equal(natureApplies(nature, scope), true);
  assert.equal(natureApplies({ ...nature, destination: 'INTERNAL' }, scope), false);
  assert.equal(natureApplies({ ...nature, ufDestination: 'RJ' }, scope), false);
  assert.equal(natureApplies({ ...nature, ufOrigin: 'MT', taxRegime: 'NORMAL' }, scope), false);
  assert.equal(natureApplies({ ...nature, destination: 'ANY' }, scope), true);
  assert.equal(natureApplies({ ...nature, active: false }, scope), false);
  assert.equal(natureApplies({ ...nature, direction: 'IN' }, scope), false);
  assert.equal(natureApplies(null, scope), false);
});

test('CFOP follows rule, nature, company default and model default in that order', () => {
  const base = { settings: { saleInternal: '5101', saleInterstate: '6101', returnInternal: '1202', returnInterstate: '2202' }, destination: 'INTERNAL' as const, returning: false };
  assert.equal(resolveCfop({ ...base, ruleCfop: '5102', natureCfop: '5933', modelDefault: '5949' }), '5102');
  assert.equal(resolveCfop({ ...base, natureCfop: '5933', modelDefault: '5949' }), '5933');
  assert.equal(resolveCfop({ ...base, modelDefault: '5949' }), '5101');
  assert.equal(resolveCfop({ ...base, settings: {}, modelDefault: '5949' }), '5949');
  assert.equal(resolveCfop({ ...base, settings: {} }), null);
});

test('interstate and return operations use their own CFOPs and never borrow an internal model default', () => {
  const base = { settings: { saleInternal: '5101', saleInterstate: '6101', returnInternal: '1202', returnInterstate: '2202' }, modelDefault: '5949' };
  assert.equal(resolveCfop({ ...base, destination: 'INTERSTATE', returning: false, ruleCfop: '5102', ruleCfopInterstate: '6102' }), '6102');
  assert.equal(resolveCfop({ ...base, destination: 'INTERSTATE', returning: false, ruleCfop: '5102' }), '6101');
  assert.equal(resolveCfop({ ...base, destination: 'INTERSTATE', returning: true }), '2202');
  assert.equal(resolveCfop({ ...base, destination: 'INTERNAL', returning: true }), '1202');
  assert.equal(resolveCfop({ settings: {}, destination: 'INTERSTATE', returning: false, ruleCfop: '5102', modelDefault: '5949' }), '5102', 'falls back to the rule CFOP so SEFAZ reports the mismatch clearly');
});
