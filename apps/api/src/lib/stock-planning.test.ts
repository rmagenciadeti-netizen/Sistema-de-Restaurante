import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePrices, conferencePurchase, earliestExpiry, expiryState, matchInvoiceItem, suggestPurchase } from './stock-planning';

test('purchase suggestion: below minimum, low coverage and nothing to buy', () => {
  assert.deepEqual(suggestPurchase({ current: 3, minimum: 5, maximum: 20, consumed30: 0 }), { quantity: 17, reason: 'BELOW_MINIMUM', coverageDays: null, target: 20 });
  assert.equal(suggestPurchase({ current: 3, minimum: 5, maximum: null, consumed30: 0 }).quantity, 7, 'without maximum the target is twice the minimum');
  const coverage = suggestPurchase({ current: 6, minimum: 2, maximum: null, consumed30: 60 });
  assert.deepEqual([coverage.reason, coverage.coverageDays, coverage.target, coverage.quantity], ['LOW_COVERAGE', 3, 28, 22], 'two weeks of consumption (2/day)');
  assert.equal(suggestPurchase({ current: 50, minimum: 5, maximum: 20, consumed30: 30 }).reason, 'NONE');
  assert.equal(suggestPurchase({ current: 5, minimum: 5, maximum: 5, consumed30: 0 }).quantity, 0, 'never suggests when the target is already reached');
});

test('expiry is compared by calendar day and keeps the earliest date on the shelf', () => {
  const now = new Date('2026-06-10T15:00:00Z');
  assert.equal(expiryState(new Date('2026-06-09T00:00:00Z'), now), 'EXPIRED');
  assert.equal(expiryState(new Date('2026-06-10T00:00:00Z'), now), 'EXPIRING', 'expires today');
  assert.equal(expiryState(new Date('2026-06-17T00:00:00Z'), now), 'EXPIRING');
  assert.equal(expiryState(new Date('2026-06-18T00:00:00Z'), now), 'OK');
  assert.equal(expiryState(null, now), 'NONE');
  const older = new Date('2026-06-12T00:00:00Z'); const newer = new Date('2026-07-12T00:00:00Z');
  assert.equal(earliestExpiry(older, newer, true), older);
  assert.equal(earliestExpiry(older, newer, false), newer, 'empty shelf: the new batch is all there is');
  assert.equal(earliestExpiry(newer, older, true), older);
  assert.equal(earliestExpiry(older, null, true), older);
});

test('price comparison ranks suppliers by last price and measures the gap', () => {
  const day = (n: number) => new Date(2026, 0, n);
  const rows = comparePrices([
    { supplierId: 'a', supplierName: 'A', unitCost: 10, at: day(1) }, { supplierId: 'a', supplierName: 'A', unitCost: 12, at: day(5) },
    { supplierId: 'b', supplierName: 'B', unitCost: 11, at: day(3) },
  ]);
  assert.deepEqual(rows.map(row => [row.supplierId, row.lastCost, row.averageCost, row.minCost, row.purchases, row.vsBest]), [['b', 11, 11, 11, 1, 0], ['a', 12, 11, 10, 2, 9.09]]);
});

test('receiving conference flags shortages, excess, missing items and price changes', () => {
  const result = conferencePurchase([
    { itemId: '1', name: 'Farinha', orderedQuantity: 10, receivedQuantity: 8, orderedUnitCost: 5, receivedUnitCost: 5 },
    { itemId: '2', name: 'Queijo', orderedQuantity: 4, receivedQuantity: 4, orderedUnitCost: 30, receivedUnitCost: 32.5 },
    { itemId: '3', name: 'Ovos', orderedQuantity: 2, receivedQuantity: 0, orderedUnitCost: 9, receivedUnitCost: null },
    { itemId: '4', name: 'Sal', orderedQuantity: 1, receivedQuantity: 2, orderedUnitCost: 3, receivedUnitCost: 2.5 },
    { itemId: '5', name: 'Açúcar', orderedQuantity: 1, receivedQuantity: null, orderedUnitCost: 4, receivedUnitCost: null },
  ]);
  assert.deepEqual(result.divergences.map(item => [item.itemId, item.kind]), [['1', 'SHORT'], ['2', 'PRICE_UP'], ['3', 'NOT_RECEIVED'], ['4', 'OVER'], ['4', 'PRICE_DOWN']]);
  assert.equal(result.orderedTotal, 10 * 5 + 4 * 30 + 2 * 9 + 3 + 4);
  assert.equal(result.receivedTotal, 8 * 5 + 4 * 32.5 + 0 + 2 * 2.5 + 4, 'unconfirmed lines count as received as ordered');
});

test('invoice items are matched to ingredients by shared words, never blindly', () => {
  const items = [{ description: 'FARINHA DE TRIGO TIPO 1 5KG' }, { description: 'Queijo Mussarela fatiado' }];
  assert.equal(matchInvoiceItem('Farinha de trigo', items)?.item, items[0]);
  assert.equal(matchInvoiceItem('Queijo muçarela', items), null, 'a misspelled name is not guessed');
  assert.equal(matchInvoiceItem('Queijo mussarela', items)?.item, items[1]);
  assert.equal(matchInvoiceItem('Óleo', items), null);
});
