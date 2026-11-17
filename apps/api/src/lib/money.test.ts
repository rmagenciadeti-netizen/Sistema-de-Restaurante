import test from 'node:test';
import assert from 'node:assert/strict';
import { moneySchema, positiveMoneySchema } from './money';

test('money input accepts only finite Decimal(12,2) values', () => {
  for (const value of [0, 0.01, 1.1, 9999999999.99]) assert.equal(moneySchema.safeParse(value).success, true, String(value));
  for (const value of [-1, 0.001, 1.005, 10000000000, NaN, Infinity, '1.00', null]) assert.equal(moneySchema.safeParse(value).success, false, String(value));
  assert.equal(positiveMoneySchema.safeParse(0).success, false);
  assert.equal(positiveMoneySchema.safeParse(0.01).success, true);
});
