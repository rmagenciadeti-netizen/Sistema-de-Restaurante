import test from 'node:test';
import assert from 'node:assert/strict';
import { averageSpent, classifyCustomer, type CustomerStats } from './crm';

const now = new Date('2026-11-18T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const stats = (orders: number, spent: number, first: number | null, last: number | null): CustomerStats => ({ id: 'x', orders, spent, firstOrderAt: first === null ? null : daysAgo(first), lastOrderAt: last === null ? null : daysAgo(last) });

test('customers are segmented by recency, frequency and spend', () => {
  const average = averageSpent([stats(5, 500, 200, 10), stats(1, 50, 5, 5), stats(2, 100, 120, 100)]);
  assert.equal(Math.round(average), 217);
  assert.equal(classifyCustomer(stats(8, 900, 300, 5), average, now), 'VIP');
  assert.equal(classifyCustomer(stats(8, 300, 300, 5), average, now), 'RECURRING', 'frequent but below the VIP spend');
  assert.equal(classifyCustomer(stats(1, 40, 3, 3), average, now), 'NEW');
  assert.equal(classifyCustomer(stats(3, 120, 200, 70), average, now), 'AT_RISK');
  assert.equal(classifyCustomer(stats(3, 120, 400, 150), average, now), 'INACTIVE');
  assert.equal(classifyCustomer(stats(0, 0, null, null), average, now), 'INACTIVE', 'never bought');
});
