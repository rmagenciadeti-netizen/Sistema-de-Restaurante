import { Prisma } from '@prisma/client';
import { MAX_MONEY } from './money';

export const ADJUST_MODES = ['SET', 'INCREASE_PERCENT', 'DECREASE_PERCENT', 'ADD', 'SUBTRACT', 'COST_MARGIN'] as const;
export type AdjustMode = typeof ADJUST_MODES[number];
export const ROUNDINGS = ['NONE', 'UP_10C', 'NEAREST_50C', 'ROUND_1'] as const;
export type Rounding = typeof ROUNDINGS[number];

export type FieldAdjustment = { mode: AdjustMode; value: number };
export type AdjustInput = { price?: FieldAdjustment | null; cost?: FieldAdjustment | null; rounding?: Rounding };
export type SkipCode = 'NO_COST' | 'PRICE_NOT_POSITIVE' | 'COST_NOT_POSITIVE' | 'TOO_HIGH' | 'UNCHANGED';

export const SKIP_MESSAGES: Record<SkipCode, string> = {
  NO_COST: 'Produto sem custo cadastrado.',
  PRICE_NOT_POSITIVE: 'O novo preço ficaria zero ou negativo.',
  COST_NOT_POSITIVE: 'O novo custo ficaria zero ou negativo.',
  TOO_HIGH: 'O novo valor excede o limite permitido.',
  UNCHANGED: 'Sem alteração de valor.',
};

export type AdjustResult =
  | { skipped: false; price: Prisma.Decimal; cost: Prisma.Decimal | null }
  | { skipped: true; code: SkipCode };

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const cents = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function roundPrice(value: Prisma.Decimal, rounding: Rounding): Prisma.Decimal {
  switch (rounding) {
    case 'UP_10C': return value.mul(10).toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL).div(10);
    case 'NEAREST_50C': return value.mul(2).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).div(2);
    case 'ROUND_1': return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    default: return cents(value);
  }
}

// Applies a percentage/amount rule to a base value; COST_MARGIN is handled by the caller because it needs the cost.
function applyMode(base: Prisma.Decimal, { mode, value }: FieldAdjustment): Prisma.Decimal {
  const amount = D(value);
  switch (mode) {
    case 'SET': return amount;
    case 'INCREASE_PERCENT': return base.mul(D(100).add(amount)).div(100);
    case 'DECREASE_PERCENT': return base.mul(D(100).sub(amount)).div(100);
    case 'ADD': return base.add(amount);
    case 'SUBTRACT': return base.sub(amount);
    default: return base;
  }
}

// New cost is computed first so a COST_MARGIN price uses the updated cost when both are changed together.
export function adjustProduct(product: { price: Prisma.Decimal; cost: Prisma.Decimal | null }, input: AdjustInput): AdjustResult {
  const rounding = input.rounding ?? 'NONE';
  let cost = product.cost;
  if (input.cost) {
    if (input.cost.mode !== 'SET' && !product.cost) return { skipped: true, code: 'NO_COST' };
    cost = cents(applyMode(product.cost ?? D(0), input.cost));
    if (cost.lte(0)) return { skipped: true, code: 'COST_NOT_POSITIVE' };
  }
  let price = product.price;
  if (input.price) {
    if (input.price.mode === 'COST_MARGIN') {
      if (!cost || cost.lte(0)) return { skipped: true, code: 'NO_COST' };
      price = cost.mul(D(100).add(D(input.price.value))).div(100);
    } else price = applyMode(product.price, input.price);
    price = roundPrice(price, rounding);
    if (price.lte(0)) return { skipped: true, code: 'PRICE_NOT_POSITIVE' };
  }
  if (price.gt(MAX_MONEY) || (cost && cost.gt(MAX_MONEY))) return { skipped: true, code: 'TOO_HIGH' };
  if (price.eq(product.price) && ((cost === null && product.cost === null) || (cost !== null && product.cost !== null && cost.eq(product.cost)))) return { skipped: true, code: 'UNCHANGED' };
  return { skipped: false, price, cost };
}
