import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { calculateCashDifference, calculateLineTotal } from './calculations';

test('calculates a currency line total using decimal arithmetic', () => {
  assert.equal(calculateLineTotal(new Prisma.Decimal('3.25'), 3).toString(), '9.75');
});

test('rejects invalid quantities', () => {
  assert.throws(() => calculateLineTotal(new Prisma.Decimal('1.00'), 0), RangeError);
});

test('calculates cash drawer difference without floating-point arithmetic', () => {
  assert.equal(calculateCashDifference(new Prisma.Decimal('100'), new Prisma.Decimal('28.40'), new Prisma.Decimal('127.90')).toString(), ' -0.5'.trim());
});
