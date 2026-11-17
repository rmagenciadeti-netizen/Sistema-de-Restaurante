// Pure profitability maths. Revenue, receipts and profit are kept apart: revenue is what was sold, receipts is what was paid,
// and profit only exists after costs. Costs that are not registered (product cost) are reported as coverage, never guessed.
export type ProfitItem = { productId: string; category: string; userId: string | null; units: number; revenue: number; unitCost: number | null };
export type ProfitInput = {
  netRevenue: number; discounts: number; cancelledCount: number; cancelledValue: number; serviceFees: number; deliveryFees: number;
  received: number; cardReceived: number; commissions: number;
  items: ProfitItem[]; expenses: { category: string; amount: number }[];
  config: { cardFeePercent: number; taxPercent: number; fixedCategories: string[]; includeCommissions: boolean };
};
export type Row = { key: string; name: string; revenue: number; cost: number; profit: number; marginPercent: number | null; units: number; costCoverage: number };
export type ProfitResult = {
  grossRevenue: number; discounts: number; cancellations: { count: number; value: number }; netRevenue: number; received: number;
  cogs: number; costCoverage: number; grossProfit: number; cardFees: number; taxes: number; commissions: number;
  variableExpenses: number; fixedExpenses: number; contributionMargin: number; contributionMarginPercent: number | null;
  operatingResult: number; operatingMarginPercent: number | null; expensesByCategory: { category: string; amount: number; kind: 'FIXED' | 'VARIABLE' }[];
};
const r2 = (value: number) => Math.round(value * 100) / 100;
const pct = (part: number, base: number) => (base > 0 ? r2((part / base) * 100) : null);

export function computeProfit(input: ProfitInput): ProfitResult {
  const itemRevenue = input.items.reduce((sum, item) => sum + item.revenue, 0);
  const costed = input.items.filter(item => item.unitCost !== null);
  const costedRevenue = costed.reduce((sum, item) => sum + item.revenue, 0);
  const cogs = costed.reduce((sum, item) => sum + item.units * (item.unitCost as number), 0);
  const fixedSet = new Set(input.config.fixedCategories.map(name => name.toLowerCase()));
  const expensesByCategory = input.expenses.map(expense => ({ category: expense.category, amount: r2(expense.amount), kind: (fixedSet.has(expense.category.toLowerCase()) ? 'FIXED' : 'VARIABLE') as 'FIXED' | 'VARIABLE' })).sort((a, b) => b.amount - a.amount);
  const fixedExpenses = expensesByCategory.filter(item => item.kind === 'FIXED').reduce((sum, item) => sum + item.amount, 0);
  const paidVariable = expensesByCategory.filter(item => item.kind === 'VARIABLE').reduce((sum, item) => sum + item.amount, 0);
  const cardFees = input.cardReceived * input.config.cardFeePercent / 100;
  const taxes = input.netRevenue * input.config.taxPercent / 100;
  const commissions = input.config.includeCommissions ? input.commissions : 0;
  const variableExpenses = paidVariable + cardFees + taxes + commissions;
  const grossProfit = input.netRevenue - cogs;
  const contributionMargin = grossProfit - variableExpenses;
  const operatingResult = contributionMargin - fixedExpenses;
  return {
    grossRevenue: r2(input.netRevenue + input.discounts), discounts: r2(input.discounts), cancellations: { count: input.cancelledCount, value: r2(input.cancelledValue) },
    netRevenue: r2(input.netRevenue), received: r2(input.received), cogs: r2(cogs), costCoverage: itemRevenue > 0 ? r2((costedRevenue / itemRevenue) * 100) : 0,
    grossProfit: r2(grossProfit), cardFees: r2(cardFees), taxes: r2(taxes), commissions: r2(commissions), variableExpenses: r2(variableExpenses), fixedExpenses: r2(fixedExpenses),
    contributionMargin: r2(contributionMargin), contributionMarginPercent: pct(contributionMargin, input.netRevenue),
    operatingResult: r2(operatingResult), operatingMarginPercent: pct(operatingResult, input.netRevenue), expensesByCategory,
  };
}

// Groups sold items (by product, category or employee). Profit only counts items with a registered cost; coverage says how much was costed.
export function groupItems(items: ProfitItem[], keyOf: (item: ProfitItem) => { key: string; name: string }): Row[] {
  const groups = new Map<string, { name: string; revenue: number; costedRevenue: number; cost: number; units: number }>();
  for (const item of items) {
    const { key, name } = keyOf(item);
    const group = groups.get(key) ?? { name, revenue: 0, costedRevenue: 0, cost: 0, units: 0 };
    group.revenue += item.revenue; group.units += item.units;
    if (item.unitCost !== null) { group.costedRevenue += item.revenue; group.cost += item.units * item.unitCost; }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key, name: group.name, revenue: r2(group.revenue), cost: r2(group.cost), units: r2(group.units),
    profit: r2(group.costedRevenue - group.cost), marginPercent: pct(group.costedRevenue - group.cost, group.costedRevenue), costCoverage: group.revenue > 0 ? r2((group.costedRevenue / group.revenue) * 100) : 0,
  })).sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);
}

export function suggestPrice(cost: number, targetMarginPercent: number): number | null {
  return targetMarginPercent >= 0 && targetMarginPercent < 100 && cost >= 0 ? r2(cost / (1 - targetMarginPercent / 100)) : null;
}
