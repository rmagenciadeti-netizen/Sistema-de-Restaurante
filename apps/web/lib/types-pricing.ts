export type Assessment = { price: string; netResult: string; grossProfit: string; ml: string | null; mla: string | null; marginOnSale: string | null; markup: string | null; variableCosts: string };
export type PricingResultOk = {
  ok: true; totalCost: string; desiredProfit: string; variablePercent: string; fixedOperational: string; minimumPrice: string; recommendedPrice: string; recommendedBeforeRounding: string;
  breakdownAtRecommended: { tax: string; cardFee: string; commission: string; operational: string; otherVariable: string };
  recommended: Assessment; minimum: Assessment; current: Assessment | null; simulated: Assessment | null; differenceToRecommended: string | null;
  status: 'NO_PRICE' | 'NEGATIVE' | 'BELOW_TARGET' | 'ON_TARGET'; formulas: string[];
};
export type PricingResult = PricingResultOk | { ok: false; code: string; message: string };
export type PricingDefaults = { marginPercent: number; taxPercent: number; cardFeePercent: number; commissionPercent: number; operationalCostPercent: number; otherVariablePercent: number; rounding: 'NONE' | 'UP_10_CENTS' | 'UP_TO_90' };
export type ProductPricingRow = { freightCost: string | number; otherAcquisitionCost: string | number; marginPercent: string | number | null; operationalCostPercent: string | number | null; operationalCostFixed: string | number | null; taxPercent: string | number | null; cardFeePercent: string | number | null; commissionPercent: string | number | null; otherVariablePercent: string | number | null };
export type ProductPricingResponse = {
  product: { id: string; name: string; price: number; cost: number | null; category: string | null }; pricing: ProductPricingRow | null; defaults: PricingDefaults; result: PricingResult;
  history: { id: string; price: string; cost: string | null; reason: string; createdAt: string }[];
};
export const STATUS_LABEL: Record<PricingResultOk['status'], { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  NO_PRICE: { label: 'Sem preço de venda', tone: 'neutral' }, NEGATIVE: { label: 'Prejuízo', tone: 'red' }, BELOW_TARGET: { label: 'Abaixo da margem desejada', tone: 'amber' }, ON_TARGET: { label: 'Dentro da meta', tone: 'green' },
};
export const HISTORY_REASON: Record<string, string> = { PRODUCT_CREATED: 'Produto cadastrado', PRODUCT_UPDATE: 'Edição do produto', COST_UPDATE: 'Custo atualizado', PRICING_APPLIED: 'Preço aplicado (Formação de Preço)', PRICING_BULK: 'Alteração em massa', BULK_PRICE_UPDATE: 'Reajuste em lote' };
export type PanelRow = { id: string; name: string; category: string; price: number; totalCost: number; ml: number | null; mla: number | null; netResult: number; recommendedPrice: number; status: PricingResultOk['status']; realizedMl: number | null; realizedUnits: number };
export type PanelResponse = {
  period: { from: string; to: string }; defaults: PricingDefaults; analyzed: number; withoutCost: { id: string; name: string }[]; invalid: { id: string; name: string; reason: string }[];
  summary: { averageMl: number | null; averageMla: number | null; negative: number; belowTarget: number; onTarget: number; noPrice: number; realizedRevenue: number; realizedCost: number; realizedMl: number | null };
  mostProfitable: PanelRow[]; leastProfitable: PanelRow[]; negative: PanelRow[]; belowTarget: PanelRow[]; byCategory: { category: string; products: number; averageMl: number | null; averageMla: number | null }[];
};
export type BulkPreview = { rows: { id: string; name: string; category: string | null; cost: number; currentPrice: number; newPrice: number; difference: number; currentMla: string | null; newMla: string | null }[]; skipped: { id: string; name: string; reason: string }[]; count: number };
