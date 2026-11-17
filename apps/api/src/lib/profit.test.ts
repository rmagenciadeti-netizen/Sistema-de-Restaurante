import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProfit, groupItems, suggestPrice, type ProfitInput } from './profit';

const base: ProfitInput = {
  netRevenue: 1000, discounts: 50, cancelledCount: 2, cancelledValue: 80, serviceFees: 0, deliveryFees: 0, received: 900, cardReceived: 400, commissions: 30,
  items: [{ productId: 'a', category: 'Lanches', userId: 'u1', units: 10, revenue: 600, unitCost: 20 }, { productId: 'b', category: 'Bebidas', userId: 'u2', units: 20, revenue: 400, unitCost: null }],
  expenses: [{ category: 'Aluguel', amount: 200 }, { category: 'Embalagens', amount: 40 }],
  config: { cardFeePercent: 2, taxPercent: 5, fixedCategories: ['aluguel'], includeCommissions: true },
};

test('revenue, receipts and profit are kept apart and costs come only from registered data', () => {
  const result = computeProfit(base);
  assert.equal(result.grossRevenue, 1050);
  assert.equal(result.received, 900);
  assert.equal(result.cogs, 200);
  assert.equal(result.costCoverage, 60);
  assert.equal(result.grossProfit, 800);
  assert.equal(result.cardFees, 8);
  assert.equal(result.taxes, 50);
  assert.equal(result.variableExpenses, 40 + 8 + 50 + 30);
  assert.equal(result.contributionMargin, 800 - 128);
  assert.equal(result.fixedExpenses, 200);
  assert.equal(result.operatingResult, 472);
  assert.equal(result.operatingMarginPercent, 47.2);
  assert.deepEqual(result.expensesByCategory.map(item => item.kind), ['FIXED', 'VARIABLE']);
});

test('commissions can be turned off and empty periods do not divide by zero', () => {
  assert.equal(computeProfit({ ...base, config: { ...base.config, includeCommissions: false } }).commissions, 0);
  const empty = computeProfit({ ...base, netRevenue: 0, discounts: 0, items: [], expenses: [], cardReceived: 0, commissions: 0, received: 0 });
  assert.equal(empty.operatingMarginPercent, null);
  assert.equal(empty.costCoverage, 0);
});

test('grouping reports profit only for costed items and the coverage', () => {
  const rows = groupItems(base.items, item => ({ key: item.category, name: item.category }));
  assert.equal(rows[0].name, 'Lanches');
  assert.equal(rows[0].profit, 400);
  assert.equal(rows[0].marginPercent, 66.67);
  const drinks = rows.find(row => row.name === 'Bebidas')!;
  assert.equal(drinks.marginPercent, null);
  assert.equal(drinks.costCoverage, 0);
});

test('price suggestion from cost and desired margin', () => {
  assert.equal(suggestPrice(10, 60), 25);
  assert.equal(suggestPrice(10, 100), null);
});
