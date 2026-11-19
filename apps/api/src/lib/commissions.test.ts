import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommissions, type CommissionRuleInput } from './commissions';

const rule = (extra: Partial<CommissionRuleInput>): CommissionRuleInput => ({ id: 'r', name: 'Regra', kind: 'SALE_PERCENT', userId: null, role: null, productId: null, percent: null, goalAmount: null, bonusAmount: null, active: true, ...extra });
const ana = { id: 'ana', name: 'Ana', role: 'WAITER', commissionPercent: 2 };
const bia = { id: 'bia', name: 'Bia', role: 'CASHIER', commissionPercent: 0 };
const items = [{ userId: 'ana', productId: 'p1', total: 100 }, { userId: 'ana', productId: 'p2', total: 200 }, { userId: 'bia', productId: 'p1', total: 50 }];

test('falls back to the flat percentage of the user and ignores people without sales', () => {
  const [a, b] = calculateCommissions([ana, bia, { id: 'c', name: 'Caio', role: 'WAITER', commissionPercent: 5 }], [], items);
  assert.equal(a.total, 6); assert.equal(b.total, 0);
  assert.equal(calculateCommissions([{ id: 'c', name: 'Caio', role: 'WAITER', commissionPercent: 5 }], [], items)[0].total, 0);
});

test('person rule beats role rule, product rule beats sale rule, inactive rules are ignored', () => {
  const rules = [
    rule({ id: '1', role: 'WAITER', percent: 4 }), rule({ id: '2', userId: 'ana', percent: 10 }), rule({ id: '3', kind: 'PRODUCT_PERCENT', productId: 'p2', percent: 1 }),
    rule({ id: '4', userId: 'ana', percent: 99, active: false }),
  ];
  const [a] = calculateCommissions([ana], rules, items);
  assert.equal(a.saleCommission, 10, '10% of p1 (100)');
  assert.equal(a.productCommission, 2, '1% of p2 (200)');
  assert.equal(a.total, 12);
  assert.equal(calculateCommissions([ana], rules.slice(0, 1), items)[0].saleCommission, 4 + 8);
});

test('goal bonus is paid once when eligible sales reach the goal', () => {
  const goal = rule({ kind: 'GOAL_BONUS', name: 'Meta 300', goalAmount: 300, bonusAmount: 50 });
  const [a, b] = calculateCommissions([ana, bia], [goal], items);
  assert.equal(a.goalBonus, 50); assert.deepEqual(a.goalsReached, ['Meta 300']); assert.equal(a.total, 56);
  assert.equal(b.goalBonus, 0);
  assert.equal(calculateCommissions([ana], [goal], items.slice(0, 1))[0].goalBonus, 0);
});
