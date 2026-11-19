import assert from 'node:assert/strict';
import test from 'node:test';
import { computePricing, effectiveInput, roundPrice, type PricingDefaults } from './pricing';
import { Prisma } from '@prisma/client';

const ok = (input: Parameters<typeof computePricing>[0]) => { const result = computePricing(input); assert.equal(result.ok, true); return result as Extract<typeof result, { ok: true }>; };

test('margin is applied on the cost: R$100 cost and 30% give R$30 profit and a R$130 base price (no other charges)', () => {
  const result = ok({ acquisitionCost: 100, marginPercent: 30 });
  assert.deepEqual([result.totalCost, result.desiredProfit, result.recommendedPrice, result.minimumPrice], ['100.00', '30.00', '130.00', '100.00']);
  assert.deepEqual([result.recommended.ml, result.recommended.mla, result.recommended.markup], ['30.00', '30.00', '1.3000']);
});

test('percentages on the selling price are added "por dentro" and the desired R$30 is preserved', () => {
  const result = ok({ acquisitionCost: 100, marginPercent: 30, taxPercent: 6, cardFeePercent: 2, commissionPercent: 2 });
  assert.equal(result.variablePercent, '10.00');
  assert.equal(result.recommendedPrice, '144.45', '130 ÷ 0.90 = 144.444… rounded up to the cent — not 130 × 1.10 = 143.00');
  assert.equal(result.recommended.netResult, '30.01');
  assert.equal(result.recommended.ml, '44.45', 'ML is the gross margin on cost; MLA is what is left after charges');
  assert.equal(result.recommended.mla, '30.01');
  assert.deepEqual(result.breakdownAtRecommended, { tax: '8.67', cardFee: '2.89', commission: '2.89', operational: '0.00', otherVariable: '0.00' });
  assert.equal(result.minimumPrice, '111.12'); assert.equal(result.minimum.netResult, '0.01', 'break-even rounded up to the cent');
});

test('acquisition costs and fixed operating cost are part of the base; nothing is counted twice', () => {
  const result = ok({ acquisitionCost: 80, freightCost: 12, otherAcquisitionCost: 8, marginPercent: 25, operationalCostFixed: 5, operationalCostPercent: 4, taxPercent: 6 });
  assert.equal(result.totalCost, '100.00'); assert.equal(result.desiredProfit, '25.00');
  assert.equal(result.recommendedPrice, '144.45', '(100 + 5 + 25) ÷ 0.90');
  assert.equal(result.recommended.netResult, '25.01', 'the fixed cost is covered and the desired R$ 25 of profit remains');
});

test('current, simulated and recommended prices are compared; status flags negative, and below target', () => {
  const base = { acquisitionCost: 100, marginPercent: 30, taxPercent: 10 };
  assert.equal(ok({ ...base, currentPrice: 90 }).status, 'NEGATIVE');
  assert.equal(ok({ ...base, currentPrice: 105 }).status, 'NEGATIVE', 'below the minimum price always loses money');
  assert.equal(ok({ ...base, currentPrice: 120 }).status, 'BELOW_TARGET');
  assert.equal(ok({ ...base, currentPrice: 144.45 }).status, 'ON_TARGET');
  assert.equal(ok(base).status, 'NO_PRICE');
  const compared = ok({ ...base, currentPrice: 120, simulatedPrice: 150 });
  assert.equal(compared.differenceToRecommended, '-24.45'); assert.equal(compared.simulated!.netResult, '35.00'); assert.equal(compared.current!.netResult, '8.00');
  assert.equal(ok({ ...base, currentPrice: 90 }).current!.netResult, '-19.00', 'negative margin is reported, never hidden (90 − 100 cost − 9 tax)');
});

test('rounding is always upwards so the desired profit is never lost', () => {
  const value = (text: string) => new Prisma.Decimal(text);
  assert.equal(roundPrice(value('144.4401'), 'NONE').toFixed(2), '144.45');
  assert.equal(roundPrice(value('144.41'), 'UP_10_CENTS').toFixed(2), '144.50');
  assert.equal(roundPrice(value('144.40'), 'UP_10_CENTS').toFixed(2), '144.40');
  assert.equal(roundPrice(value('144.44'), 'UP_TO_90').toFixed(2), '144.90');
  assert.equal(roundPrice(value('144.91'), 'UP_TO_90').toFixed(2), '145.90');
  const rounded = ok({ acquisitionCost: 100, marginPercent: 30, taxPercent: 10, rounding: 'UP_TO_90' });
  assert.equal(rounded.recommendedPrice, '144.90'); assert.equal(rounded.recommendedBeforeRounding, '144.44'); assert.ok(Number(rounded.recommended.netResult) >= 30);
});

test('invalid situations are explained instead of producing a price', () => {
  assert.deepEqual(computePricing({ acquisitionCost: 0, marginPercent: 30 }), { ok: false, code: 'NO_COST', message: 'Informe o custo de aquisição para calcular o preço.' });
  const high = computePricing({ acquisitionCost: 10, marginPercent: 30, taxPercent: 60, cardFeePercent: 40 });
  assert.equal(high.ok, false); assert.equal(!high.ok && high.code, 'VARIABLE_PERCENT_TOO_HIGH');
  assert.equal(computePricing({ acquisitionCost: 10, marginPercent: -5 }).ok, false);
  assert.equal(computePricing({ acquisitionCost: 10, freightCost: -1, marginPercent: 1 }).ok, false);
});

test('product overrides win over company defaults; a null override inherits', () => {
  const defaults: PricingDefaults = { marginPercent: 30, taxPercent: 6, cardFeePercent: 2, commissionPercent: 0, operationalCostPercent: 0, otherVariablePercent: 0, rounding: 'NONE' };
  const inherited = effectiveInput({ cost: 50, price: 90 }, null, defaults);
  assert.deepEqual([inherited.marginPercent, inherited.taxPercent, inherited.acquisitionCost, inherited.currentPrice], [30, 6, 50, 90]);
  const own = effectiveInput({ cost: 50, price: 90 }, { freightCost: 5, otherAcquisitionCost: 0, marginPercent: new Prisma.Decimal(45), operationalCostPercent: null, operationalCostFixed: null, taxPercent: new Prisma.Decimal(0), cardFeePercent: null, commissionPercent: new Prisma.Decimal(3), otherVariablePercent: null }, defaults);
  assert.deepEqual([String(own.marginPercent), String(own.taxPercent), own.cardFeePercent, String(own.commissionPercent), String(own.freightCost)], ['45', '0', 2, '3', '5'], 'an explicit 0% tax is an override, not "inherit"');
  const result = ok(own); assert.equal(result.totalCost, '55.00');
  assert.equal(effectiveInput({ cost: 50, price: 90 }, null, defaults, { marginPercent: 10 }).marginPercent, 10, 'a simulated margin does not touch the saved one');
});
