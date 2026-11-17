import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { adjustProduct, roundPrice } from './bulk-adjust';

const D = (value: string) => new Prisma.Decimal(value);
const product = (price: string, cost: string | null = null) => ({ price: D(price), cost: cost === null ? null : D(cost) });

test('price rounding modes', () => {
  assert.equal(roundPrice(D('10.01'), 'UP_10C').toFixed(2), '10.10');
  assert.equal(roundPrice(D('10.10'), 'UP_10C').toFixed(2), '10.10');
  assert.equal(roundPrice(D('10.26'), 'NEAREST_50C').toFixed(2), '10.50');
  assert.equal(roundPrice(D('10.24'), 'NEAREST_50C').toFixed(2), '10.00');
  assert.equal(roundPrice(D('10.50'), 'ROUND_1').toFixed(2), '11.00');
  assert.equal(roundPrice(D('10.567'), 'NONE').toFixed(2), '10.57');
});

test('percent, fixed and set adjustments', () => {
  const run = (mode: 'SET' | 'INCREASE_PERCENT' | 'DECREASE_PERCENT' | 'ADD' | 'SUBTRACT', value: number) => adjustProduct(product('20.00'), { price: { mode, value } });
  assert.deepEqual(run('INCREASE_PERCENT', 10), { skipped: false, price: D('22'), cost: null });
  assert.equal((run('DECREASE_PERCENT', 25) as { price: Prisma.Decimal }).price.toFixed(2), '15.00');
  assert.equal((run('ADD', 1.5) as { price: Prisma.Decimal }).price.toFixed(2), '21.50');
  assert.equal((run('SUBTRACT', 5) as { price: Prisma.Decimal }).price.toFixed(2), '15.00');
  assert.equal((run('SET', 9.9) as { price: Prisma.Decimal }).price.toFixed(2), '9.90');
});

test('skips items that become non-positive, lack cost or do not change', () => {
  assert.deepEqual(adjustProduct(product('5.00'), { price: { mode: 'SUBTRACT', value: 5 } }), { skipped: true, code: 'PRICE_NOT_POSITIVE' });
  assert.deepEqual(adjustProduct(product('5.00'), { price: { mode: 'COST_MARGIN', value: 100 } }), { skipped: true, code: 'NO_COST' });
  assert.deepEqual(adjustProduct(product('5.00'), { cost: { mode: 'ADD', value: 1 } }), { skipped: true, code: 'NO_COST' });
  assert.deepEqual(adjustProduct(product('5.00', '2.00'), { cost: { mode: 'SUBTRACT', value: 2 } }), { skipped: true, code: 'COST_NOT_POSITIVE' });
  assert.deepEqual(adjustProduct(product('5.00'), { price: { mode: 'SET', value: 5 } }), { skipped: true, code: 'UNCHANGED' });
});

test('cost margin uses the updated cost and rounding', () => {
  const result = adjustProduct(product('9.00', '4.00'), { cost: { mode: 'INCREASE_PERCENT', value: 25 }, price: { mode: 'COST_MARGIN', value: 100 }, rounding: 'UP_10C' });
  assert.ok(!result.skipped);
  if (!result.skipped) { assert.equal(result.cost?.toFixed(2), '5.00'); assert.equal(result.price.toFixed(2), '10.00'); }
});
