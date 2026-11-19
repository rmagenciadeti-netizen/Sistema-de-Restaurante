import { Prisma } from '@prisma/client';
import type { TenantSettingsData } from './settings';

// Price-formation engine. Pure and deterministic: every figure is derived from the inputs below and the formulas are returned with the result.
//
//  totalCost      = acquisition + freight + other acquisition costs
//  desiredProfit  = totalCost × margin%                      (margin is ON COST, never on the selling price)
//  variable%      = tax% + card fee% + commission% + operational% + other variable%   (all are percentages OF THE SELLING PRICE)
//  recommended    = (totalCost + fixed operational per unit + desiredProfit) ÷ (1 − variable%)   ("por dentro": the percentages also fall on the margin)
//  minimum        = (totalCost + fixed operational per unit) ÷ (1 − variable%)                     (break-even: net result = 0)
//  net result     = price × (1 − variable%) − totalCost − fixed operational per unit
//  ML             = (price − totalCost) ÷ totalCost         gross margin on cost
//  MLA            = net result ÷ totalCost                  margin after taxes, fees, commissions and operating costs, on cost
//  margin on sale = net result ÷ price;  markup = price ÷ totalCost

export type Rounding = 'NONE' | 'UP_10_CENTS' | 'UP_TO_90';
export type PricingInput = {
  acquisitionCost: Prisma.Decimal.Value; freightCost?: Prisma.Decimal.Value; otherAcquisitionCost?: Prisma.Decimal.Value;
  marginPercent: Prisma.Decimal.Value;
  taxPercent?: Prisma.Decimal.Value; cardFeePercent?: Prisma.Decimal.Value; commissionPercent?: Prisma.Decimal.Value; operationalCostPercent?: Prisma.Decimal.Value; otherVariablePercent?: Prisma.Decimal.Value;
  operationalCostFixed?: Prisma.Decimal.Value;
  currentPrice?: Prisma.Decimal.Value | null; simulatedPrice?: Prisma.Decimal.Value | null; rounding?: Rounding;
};
export type PriceAssessment = { price: string; netResult: string; grossProfit: string; ml: string | null; mla: string | null; marginOnSale: string | null; markup: string | null; variableCosts: string };
export type PricingResult = {
  ok: true;
  totalCost: string; desiredProfit: string; variablePercent: string; fixedOperational: string;
  minimumPrice: string; recommendedPrice: string; recommendedBeforeRounding: string;
  breakdownAtRecommended: { tax: string; cardFee: string; commission: string; operational: string; otherVariable: string };
  recommended: PriceAssessment; minimum: PriceAssessment; current: PriceAssessment | null; simulated: PriceAssessment | null;
  differenceToRecommended: string | null; status: 'NO_PRICE' | 'NEGATIVE' | 'BELOW_TARGET' | 'ON_TARGET';
  formulas: string[];
} | { ok: false; code: 'NO_COST' | 'VARIABLE_PERCENT_TOO_HIGH' | 'INVALID_INPUT'; message: string };

const D = (value: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(value ?? 0);
const money = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
const pct = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);

// Rounding is always upwards: a rounded price can never push the result below the desired profit.
export function roundPrice(price: Prisma.Decimal, rounding: Rounding): Prisma.Decimal {
  const cents = price.mul(100).ceil();
  if (rounding === 'NONE') return cents.div(100);
  if (rounding === 'UP_10_CENTS') return cents.div(10).ceil().div(10);
  const reais = cents.div(100).floor(); const candidate = reais.add(0.9);
  return candidate.mul(100).gte(cents) ? candidate : reais.add(1.9);
}

export const FORMULAS = [
  'Custo total = custo de aquisição + frete + outras despesas de aquisição.',
  'Lucro desejado = custo total × margem desejada (sobre o custo).',
  'Percentuais variáveis (tributos, taxa de cartão, comissão, custo operacional %, outras) incidem sobre o preço de venda.',
  'Preço recomendado = (custo total + custo operacional fixo por unidade + lucro desejado) ÷ (1 − soma dos percentuais variáveis) — cálculo "por dentro".',
  'Preço mínimo = (custo total + custo operacional fixo por unidade) ÷ (1 − soma dos percentuais variáveis): resultado líquido zero.',
  'Resultado líquido = preço × (1 − percentuais variáveis) − custo total − custo operacional fixo por unidade.',
  'ML (margem de lucro) = (preço − custo total) ÷ custo total. MLA (margem ajustada) = resultado líquido ÷ custo total.',
  'Margem sobre a venda = resultado líquido ÷ preço. Markup = preço ÷ custo total.',
];

function assess(price: Prisma.Decimal, totalCost: Prisma.Decimal, fixed: Prisma.Decimal, variablePercent: Prisma.Decimal): PriceAssessment {
  const variable = price.mul(variablePercent).div(100);
  const net = price.sub(variable).sub(totalCost).sub(fixed);
  const gross = price.sub(totalCost);
  const positiveCost = totalCost.gt(0); const positivePrice = price.gt(0);
  return {
    price: money(price), netResult: money(net), grossProfit: money(gross), variableCosts: money(variable),
    ml: positiveCost ? pct(gross.div(totalCost).mul(100)) : null, mla: positiveCost ? pct(net.div(totalCost).mul(100)) : null,
    marginOnSale: positivePrice ? pct(net.div(price).mul(100)) : null, markup: positiveCost ? price.div(totalCost).toDecimalPlaces(4).toFixed(4) : null,
  };
}

export function computePricing(input: PricingInput): PricingResult {
  const fields = [input.acquisitionCost, input.freightCost, input.otherAcquisitionCost, input.marginPercent, input.taxPercent, input.cardFeePercent, input.commissionPercent, input.operationalCostPercent, input.otherVariablePercent, input.operationalCostFixed];
  try { for (const value of fields) if (value !== undefined && value !== null && (!D(value).isFinite() || D(value).isNeg())) return { ok: false, code: 'INVALID_INPUT', message: 'Custos e percentuais não podem ser negativos.' }; }
  catch { return { ok: false, code: 'INVALID_INPUT', message: 'Valor numérico inválido.' }; }
  const totalCost = D(input.acquisitionCost).add(D(input.freightCost)).add(D(input.otherAcquisitionCost));
  if (totalCost.lte(0)) return { ok: false, code: 'NO_COST', message: 'Informe o custo de aquisição para calcular o preço.' };
  const percents = { tax: D(input.taxPercent), cardFee: D(input.cardFeePercent), commission: D(input.commissionPercent), operational: D(input.operationalCostPercent), otherVariable: D(input.otherVariablePercent) };
  const variablePercent = Object.values(percents).reduce((sum, value) => sum.add(value), new Prisma.Decimal(0));
  if (variablePercent.gte(100)) return { ok: false, code: 'VARIABLE_PERCENT_TOO_HIGH', message: `Tributos, taxas e despesas somam ${pct(variablePercent)}% do preço: acima de 100% nenhum preço gera lucro.` };
  const fixed = D(input.operationalCostFixed);
  const factor = new Prisma.Decimal(1).sub(variablePercent.div(100));
  const desiredProfit = totalCost.mul(D(input.marginPercent)).div(100);
  const rawRecommended = totalCost.add(fixed).add(desiredProfit).div(factor);
  const recommended = roundPrice(rawRecommended, input.rounding ?? 'NONE');
  const minimum = roundPrice(totalCost.add(fixed).div(factor), 'NONE');
  const current = input.currentPrice !== undefined && input.currentPrice !== null ? assess(D(input.currentPrice), totalCost, fixed, variablePercent) : null;
  const simulated = input.simulatedPrice !== undefined && input.simulatedPrice !== null ? assess(D(input.simulatedPrice), totalCost, fixed, variablePercent) : null;
  const target = totalCost.mul(D(input.marginPercent)).div(100);
  let status: 'NO_PRICE' | 'NEGATIVE' | 'BELOW_TARGET' | 'ON_TARGET' = 'NO_PRICE';
  if (current && D(current.price).gt(0)) {
    const net = D(current.netResult);
    status = net.lt(0) ? 'NEGATIVE' : net.lt(target.sub(0.005)) ? 'BELOW_TARGET' : 'ON_TARGET';
  }
  return {
    ok: true, totalCost: money(totalCost), desiredProfit: money(desiredProfit), variablePercent: pct(variablePercent), fixedOperational: money(fixed),
    minimumPrice: money(minimum), recommendedPrice: money(recommended), recommendedBeforeRounding: money(rawRecommended),
    breakdownAtRecommended: Object.fromEntries(Object.entries(percents).map(([key, value]) => [key, money(recommended.mul(value).div(100))])) as { tax: string; cardFee: string; commission: string; operational: string; otherVariable: string },
    recommended: assess(recommended, totalCost, fixed, variablePercent), minimum: assess(minimum, totalCost, fixed, variablePercent), current, simulated,
    differenceToRecommended: current ? money(D(current.price).sub(recommended)) : null, status, formulas: FORMULAS,
  };
}

// ---- Effective inputs: product overrides over company defaults ----
export type PricingDefaults = { marginPercent: number; taxPercent: number; cardFeePercent: number; commissionPercent: number; operationalCostPercent: number; otherVariablePercent: number; rounding: Rounding };
export type ProductPricingRow = {
  freightCost: Prisma.Decimal.Value; otherAcquisitionCost: Prisma.Decimal.Value; marginPercent: Prisma.Decimal.Value | null; operationalCostPercent: Prisma.Decimal.Value | null; operationalCostFixed: Prisma.Decimal.Value | null;
  taxPercent: Prisma.Decimal.Value | null; cardFeePercent: Prisma.Decimal.Value | null; commissionPercent: Prisma.Decimal.Value | null; otherVariablePercent: Prisma.Decimal.Value | null;
} | null;
export function effectiveInput(product: { cost: Prisma.Decimal.Value | null; price: Prisma.Decimal.Value }, row: ProductPricingRow, defaults: PricingDefaults, overrides: { simulatedPrice?: Prisma.Decimal.Value | null; marginPercent?: Prisma.Decimal.Value | null } = {}): PricingInput {
  const pick = (own: Prisma.Decimal.Value | null | undefined, fallback: number) => own !== null && own !== undefined ? own : fallback;
  return {
    acquisitionCost: product.cost ?? 0, freightCost: row?.freightCost ?? 0, otherAcquisitionCost: row?.otherAcquisitionCost ?? 0,
    marginPercent: overrides.marginPercent ?? pick(row?.marginPercent, defaults.marginPercent), taxPercent: pick(row?.taxPercent, defaults.taxPercent), cardFeePercent: pick(row?.cardFeePercent, defaults.cardFeePercent),
    commissionPercent: pick(row?.commissionPercent, defaults.commissionPercent), operationalCostPercent: pick(row?.operationalCostPercent, defaults.operationalCostPercent), otherVariablePercent: pick(row?.otherVariablePercent, defaults.otherVariablePercent),
    operationalCostFixed: row?.operationalCostFixed ?? 0, currentPrice: product.price, simulatedPrice: overrides.simulatedPrice ?? null, rounding: defaults.rounding,
  };
}

export function pricingDefaults(settings: TenantSettingsData): PricingDefaults {
  return {
    marginPercent: settings.products.defaultMarginPercent, taxPercent: settings.profit.taxPercent, cardFeePercent: settings.profit.cardFeePercent,
    commissionPercent: settings.pricing.commissionPercent, operationalCostPercent: settings.pricing.operationalCostPercent, otherVariablePercent: settings.pricing.otherVariablePercent, rounding: settings.pricing.rounding,
  };
}
