import { FinancialEntryStatus, FinancialEntryType, OrderStatus, PaymentStatus, Prisma, StockMovementType } from '@prisma/client';
import { MANAGEMENT_ROLES } from '../permissions';
import { prisma } from '../prisma';
import { loadSettings } from '../settings';
import { addDays, forecastWithRange, goalProgress } from '../intelligence';
import { localParts } from '../scheduling';
import { computePricing, effectiveInput, pricingDefaults } from '../pricing';
import { averageSpent, classifyCustomer, type CustomerStats } from '../crm';
import type { Alert, AiContext, Period, ToolDef, ToolResult } from './types';
import { brl, canSeeMoney, daysBetween, n, pct, r2, result, tenantWhere } from './scope';

const CAP = 50_000;
const completed = (ctx: AiContext, period: Period) => ({ tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: OrderStatus.COMPLETED, createdAt: { gte: period.from, lte: period.to } });
const previousPeriod = (period: Period): Period => { const length = period.to.getTime() - period.from.getTime(); return { from: new Date(period.from.getTime() - length - 1), to: new Date(period.from.getTime() - 1) }; };
const change = (current: number, previous: number) => (previous === 0 ? null : r2(((current - previous) / Math.abs(previous)) * 100));
const open = (entry: { amount: Prisma.Decimal; paidAmount: Prisma.Decimal }) => Math.max(0, n(entry.amount) - n(entry.paidAmount));

// ---------------- FINANCE ----------------
const financeOverview: ToolDef = {
  name: 'overview', description: 'Contas a pagar/receber, vencimentos, inadimplência e fluxo de caixa realizado e projetado', parts: ['finance'],
  async run(ctx, period) {
    const scope = tenantWhere(ctx); const now = new Date(); const horizon = new Date(now.getTime() + 30 * 86_400_000);
    const entries = await prisma.financialEntry.findMany({ where: { ...scope, status: FinancialEntryStatus.OPEN }, select: { type: true, amount: true, paidAmount: true, dueAt: true }, take: CAP });
    const sum = (type: FinancialEntryType, predicate: (due: Date | null) => boolean) => r2(entries.filter(entry => entry.type === type && predicate(entry.dueAt)).reduce((total, entry) => total + open(entry), 0));
    const overdue = (due: Date | null) => due !== null && due < now; const upcoming = (due: Date | null) => due !== null && due >= now && due <= horizon;
    const [received, spent, otherIncome, payments, byCategory, unresolvedTef] = await Promise.all([
      prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.INCOME, status: FinancialEntryStatus.PAID, settledAt: { gte: period.from, lte: period.to } }, _sum: { paidAmount: true } }),
      prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: period.from, lte: period.to } }, _sum: { paidAmount: true } }),
      prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.INCOME, orderId: null, status: FinancialEntryStatus.PAID, settledAt: { gte: period.from, lte: period.to } }, _sum: { paidAmount: true } }),
      prisma.payment.groupBy({ by: ['method'], where: { ...scope, status: PaymentStatus.CONFIRMED, paidAt: { gte: period.from, lte: period.to } }, _sum: { amount: true } }),
      prisma.financialEntry.groupBy({ by: ['category'], where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: period.from, lte: period.to } }, _sum: { paidAmount: true }, orderBy: { _sum: { paidAmount: 'desc' } }, take: 5 }),
      prisma.tefTransaction.count({ where: { ...scope, status: { in: ['PENDING', 'TIMEOUT', 'UNKNOWN'] } } }),
    ]);
    const paymentsTotal = r2(payments.reduce((total, row) => total + n(row._sum.amount), 0));
    const cashIn = r2(paymentsTotal + n(otherIncome._sum.paidAmount)); const cashOut = r2(n(spent._sum.paidAmount));
    const data = {
      payablesOpen: sum('EXPENSE', () => true), receivablesOpen: sum('INCOME', () => true), payablesOverdue: sum('EXPENSE', overdue), receivablesOverdue: sum('INCOME', overdue),
      payablesNext30d: sum('EXPENSE', upcoming), receivablesNext30d: sum('INCOME', upcoming), overdueCount: { payables: entries.filter(entry => entry.type === 'EXPENSE' && overdue(entry.dueAt)).length, receivables: entries.filter(entry => entry.type === 'INCOME' && overdue(entry.dueAt)).length },
      realizedCashFlow: { salesReceipts: paymentsTotal, otherIncomeReceived: r2(n(otherIncome._sum.paidAmount)), totalIn: cashIn, expensesPaid: cashOut, net: r2(cashIn - cashOut) },
      receivablesSettledInPeriod: r2(n(received._sum.paidAmount)), receiptsByMethod: payments.map(row => ({ method: row.method, amount: r2(n(row._sum.amount)) })),
      topExpenseCategories: byCategory.map(row => ({ category: row.category ?? 'Sem categoria', amount: r2(n(row._sum.paidAmount)) })),
      projectedNet30d: r2(sum('INCOME', upcoming) - sum('EXPENSE', upcoming)), unresolvedTefTransactions: unresolvedTef,
    };
    const alerts: Alert[] = [];
    if (data.payablesOverdue > 0) alerts.push({ severity: 'critical', message: `Contas a pagar vencidas: ${brl(data.payablesOverdue)} (${data.overdueCount.payables} lançamento(s)).` });
    if (data.receivablesOverdue > 0) alerts.push({ severity: 'warning', message: `Inadimplência (contas a receber vencidas): ${brl(data.receivablesOverdue)} (${data.overdueCount.receivables} lançamento(s)).` });
    if (data.projectedNet30d < 0) alerts.push({ severity: 'warning', message: `Projeção dos próximos 30 dias negativa (${brl(data.projectedNet30d)}): vencimentos a pagar superam os a receber.` });
    if (unresolvedTef > 0) alerts.push({ severity: 'warning', message: `${unresolvedTef} transação(ões) TEF sem desfecho confirmado.` });
    return result(ctx, period, {
      tool: 'finance.overview', title: 'Gestão financeira', source: 'Lançamentos financeiros (FinancialEntry) e pagamentos confirmados (Payment) do estabelecimento', kind: 'MIXED', data,
      highlights: [`Fluxo de caixa realizado no período: entradas ${brl(cashIn)} − saídas ${brl(cashOut)} = ${brl(data.realizedCashFlow.net)}.`, `A pagar em aberto: ${brl(data.payablesOpen)}; a receber em aberto: ${brl(data.receivablesOpen)}.`, `Próximos 30 dias (previsão por vencimento, ESTIMATIVA): entradas ${brl(data.receivablesNext30d)}, saídas ${brl(data.payablesNext30d)}.`],
      alerts, limitations: ['Fluxo realizado = recebimentos de vendas confirmados + outras receitas baixadas − despesas pagas; não é lucro nem saldo bancário disponível.', 'A projeção considera apenas lançamentos em aberto por data de vencimento, sem garantia de pagamento.'],
      llmFacts: { ...data, topExpenseCategories: data.topExpenseCategories },
    });
  },
};

// ---------------- SALES ----------------
async function soldByProduct(ctx: AiContext, period: Period) {
  const rows = await prisma.orderItem.groupBy({ by: ['productId'], where: { parentItemId: null, order: completed(ctx, period) }, _sum: { total: true, quantity: true } });
  const products = await prisma.product.findMany({ where: { tenantId: ctx.tenantId, id: { in: rows.map(row => row.productId) } }, select: { id: true, name: true, category: { select: { name: true } } } });
  const info = new Map(products.map(product => [product.id, product]));
  return rows.map(row => ({ productId: row.productId, name: info.get(row.productId)?.name ?? 'Produto removido', category: info.get(row.productId)?.category?.name ?? 'Sem categoria', revenue: r2(n(row._sum.total)), quantity: n(row._sum.quantity) })).sort((a, b) => b.revenue - a.revenue);
}
// ABC by cumulative revenue share BEFORE the item: the best seller is always class A.
function abc<T extends { revenue: number }>(rows: T[]) {
  const total = rows.reduce((sum, row) => sum + row.revenue, 0); let acc = 0;
  return rows.map(row => { const before = total > 0 ? acc / total : 0; acc += row.revenue; return { ...row, class: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C' }; });
}

const salesSummary: ToolDef = {
  name: 'summary', description: 'Vendas por período, canal, produto, categoria e atendente; ticket médio e comparação', parts: ['orders', 'items', 'settings'],
  async run(ctx, period) {
    const prev = previousPeriod(period);
    const [orders, previousOrders, products, cancelled] = await Promise.all([
      prisma.order.findMany({ where: completed(ctx, period), select: { total: true, channel: true, createdAt: true, createdByUserId: true }, take: CAP }),
      prisma.order.aggregate({ where: completed(ctx, prev), _sum: { total: true }, _count: true }),
      soldByProduct(ctx, period),
      prisma.order.count({ where: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: OrderStatus.CANCELLED, createdAt: { gte: period.from, lte: period.to } } }),
    ]);
    const revenue = r2(orders.reduce((total, order) => total + n(order.total), 0)); const count = orders.length;
    const byChannel = new Map<string, { revenue: number; orders: number }>(); const byWeekday = new Array<{ revenue: number; days: Set<string> }>(7).fill(null as never).map(() => ({ revenue: 0, days: new Set<string>() }));
    const byUser = new Map<string, { revenue: number; orders: number }>();
    for (const order of orders) {
      const channel = byChannel.get(order.channel) ?? { revenue: 0, orders: 0 }; channel.revenue += n(order.total); channel.orders++; byChannel.set(order.channel, channel);
      const slot = byWeekday[order.createdAt.getUTCDay()]; slot.revenue += n(order.total); slot.days.add(order.createdAt.toISOString().slice(0, 10));
      if (order.createdByUserId) { const user = byUser.get(order.createdByUserId) ?? { revenue: 0, orders: 0 }; user.revenue += n(order.total); user.orders++; byUser.set(order.createdByUserId, user); }
    }
    const users = byUser.size ? await prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...byUser.keys()] } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map(user => [user.id, user.name]));
    const categories = new Map<string, number>(); for (const product of products) categories.set(product.category, (categories.get(product.category) ?? 0) + product.revenue);
    const previousRevenue = r2(n(previousOrders._sum.total)); const ranked = abc(products);
    const data = {
      revenue, orders: count, averageTicket: count ? r2(revenue / count) : null, cancelledOrders: cancelled,
      previousPeriod: { revenue: previousRevenue, orders: previousOrders._count, from: prev.from.toISOString(), to: prev.to.toISOString() }, revenueChangePercent: change(revenue, previousRevenue),
      byChannel: [...byChannel.entries()].map(([channel, row]) => ({ channel, revenue: r2(row.revenue), orders: row.orders })).sort((a, b) => b.revenue - a.revenue),
      byCategory: [...categories.entries()].map(([category, value]) => ({ category, revenue: r2(value) })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      topProducts: ranked.slice(0, 10), bottomProducts: [...ranked].reverse().slice(0, 5),
      byWeekday: byWeekday.map((slot, day) => ({ weekday: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][day], averageRevenuePerDay: slot.days.size ? r2(slot.revenue / slot.days.size) : null })),
      byAttendant: [...byUser.entries()].map(([id, row]) => ({ name: userName.get(id) ?? 'Usuário removido', revenue: r2(row.revenue), orders: row.orders })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      // Run-rate projection: average per day × days of the period. A projection, not a commitment.
      dailyAverage: r2(revenue / daysBetween(period)),
    };
    // Forecast and goal use their own fixed history (last 8 weeks and the current month), independent of the period the user picked.
    const settings = await loadSettings(prisma, ctx.tenantId); const tz = settings.hours.timezone; const now = new Date(); const today = localParts(now, tz).day;
    const history = await prisma.order.findMany({ where: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: OrderStatus.COMPLETED, createdAt: { gte: new Date(`${addDays(today, -58)}T00:00:00Z`) } }, select: { total: true, createdAt: true }, take: 50_000 });
    const dayTotals = new Map<string, number>(); for (const order of history) { const day = localParts(order.createdAt, tz).day; dayTotals.set(day, (dayTotals.get(day) ?? 0) + n(order.total)); }
    const monthPrefix = today.slice(0, 7); let monthToDate = 0; for (const [day, value] of dayTotals) if (day.startsWith(monthPrefix) && day <= today) monthToDate += value;
    const forecast = forecastWithRange(dayTotals, today, monthToDate);
    const monthlyGoal = settings.intelligence.monthlyGoal;
    const goal = monthlyGoal > 0 ? { ...goalProgress(monthToDate, monthlyGoal, now, tz), projectedToReach: forecast ? forecast.month!.projection >= monthlyGoal : null, projectedRange: forecast ? { low: forecast.month!.low, high: forecast.month!.high } : null } : null;
    Object.assign(data, { forecast: forecast ?? { unavailable: true, reason: 'Dados insuficientes: são necessários pelo menos 14 dias com vendas nas últimas 8 semanas.' }, goal: goal ?? { unavailable: true, reason: 'Nenhuma meta mensal cadastrada em RM Inteligência.' } });
    const alerts: Alert[] = [];
    if (data.revenueChangePercent !== null && data.revenueChangePercent <= -20) alerts.push({ severity: 'warning', message: `Faturamento ${pct(Math.abs(data.revenueChangePercent))} abaixo do período anterior equivalente.` });
    return result(ctx, period, {
      tool: 'sales.summary', title: 'Vendas', source: 'Pedidos concluídos (Order/OrderItem) do período; comparação com o período imediatamente anterior de mesma duração', kind: 'FACT', data,
      highlights: [`${count} venda(s) concluída(s), faturamento ${brl(revenue)}, ticket médio ${data.averageTicket === null ? '—' : brl(data.averageTicket)}.`, data.revenueChangePercent === null ? 'Sem vendas no período anterior para comparar.' : `Variação do faturamento sobre o período anterior (${brl(previousRevenue)}): ${pct(data.revenueChangePercent)}.`, data.topProducts[0] ? `Produto de maior faturamento: ${data.topProducts[0].name} (${brl(data.topProducts[0].revenue)}).` : 'Sem itens vendidos no período.'],
      alerts, limitations: ['Faturamento é o valor vendido; não é lucro nem valor recebido.', 'Previsão e meta são estimativas com faixa de incerteza (±1 desvio-padrão); a meta usa o mês corrente inteiro.', count >= CAP ? `Análise limitada às primeiras ${CAP} vendas do período.` : 'Sem limitações de volume neste período.'],
      llmFacts: { revenue, orders: count, averageTicket: data.averageTicket, previousRevenue, revenueChangePercent: data.revenueChangePercent, byChannel: data.byChannel, topProducts: data.topProducts.slice(0, 5).map(item => ({ name: item.name, revenue: item.revenue, class: item.class })) },
    });
  },
};

// ---------------- STOCK / PURCHASING / WASTE (shared computations) ----------------
async function ingredientCoverage(ctx: AiContext, windowDays = 30) {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const [ingredients, consumption, lastMovement] = await Promise.all([
    prisma.ingredient.findMany({ where: { ...tenantWhere(ctx), active: true }, select: { id: true, name: true, unitOfMeasure: true, currentStock: true, minimumStock: true, averageCost: true }, take: 5000 }),
    prisma.stockMovement.groupBy({ by: ['ingredientId'], where: { ...tenantWhere(ctx), type: StockMovementType.ORDER_CONSUMPTION, createdAt: { gte: since } }, _sum: { quantity: true } }),
    prisma.stockMovement.groupBy({ by: ['ingredientId'], where: { ...tenantWhere(ctx), createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }, _max: { createdAt: true } }),
  ]);
  const used = new Map(consumption.map(row => [row.ingredientId, Math.abs(n(row._sum.quantity))])); const last = new Map(lastMovement.map(row => [row.ingredientId, row._max.createdAt]));
  return ingredients.map(item => {
    const avgDaily = (used.get(item.id) ?? 0) / windowDays; const stock = n(item.currentStock); const min = item.minimumStock === null ? null : n(item.minimumStock);
    return { id: item.id, name: item.name, unit: item.unitOfMeasure, stock, minimum: min, averageCost: n(item.averageCost), avgDailyConsumption: avgDaily > 0 ? Math.round(avgDaily * 1000) / 1000 : 0, coverageDays: avgDaily > 0 ? r2(stock / avgDaily) : null, belowMinimum: min !== null && stock <= min, lastMovementAt: last.get(item.id) ?? null };
  });
}

const stockCoverage: ToolDef = {
  name: 'coverage', description: 'Cobertura de estoque, risco de ruptura, itens parados, curva ABC e divergências de inventário', parts: ['ingredients', 'stockMovements', 'products', 'items'],
  async run(ctx, period) {
    const money = canSeeMoney(ctx);
    const [coverage, adjustments, controlled, products] = await Promise.all([
      ingredientCoverage(ctx),
      prisma.stockMovement.findMany({ where: { ...tenantWhere(ctx), type: StockMovementType.ADJUSTMENT, createdAt: { gte: period.from, lte: period.to } }, select: { quantity: true, unitCost: true, ingredientId: true }, take: CAP }),
      prisma.product.findMany({ where: { ...tenantWhere(ctx), active: true, stockControlled: true }, select: { name: true, stockQuantity: true, stockMin: true }, take: 5000 }),
      soldByProduct(ctx, period),
    ]);
    const risk = coverage.filter(item => item.belowMinimum || (item.coverageDays !== null && item.coverageDays < 3)).sort((a, b) => (a.coverageDays ?? 0) - (b.coverageDays ?? 0));
    const staleBefore = Date.now() - 30 * 86_400_000;
    const stale = coverage.filter(item => item.stock > 0 && (!item.lastMovementAt || item.lastMovementAt.getTime() < staleBefore));
    const productsLow = controlled.filter(product => product.stockMin !== null && n(product.stockQuantity) <= n(product.stockMin));
    const adjustmentNet = r2(adjustments.reduce((total, move) => total + n(move.quantity), 0));
    const data = {
      ingredientsTracked: coverage.length, atRisk: risk.slice(0, 15).map(item => ({ name: item.name, unit: item.unit, stock: item.stock, minimum: item.minimum, avgDailyConsumption: item.avgDailyConsumption, coverageDays: item.coverageDays })),
      stale: stale.slice(0, 15).map(item => ({ name: item.name, unit: item.unit, stock: item.stock, ...(money ? { immobilizedValue: r2(item.stock * item.averageCost) } : {}) })),
      staleCount: stale.length, productsBelowMinimum: productsLow.slice(0, 15).map(product => ({ name: product.name, stock: n(product.stockQuantity), minimum: n(product.stockMin) })),
      abc: { A: abc(products).filter(item => item.class === 'A').length, B: abc(products).filter(item => item.class === 'B').length, C: abc(products).filter(item => item.class === 'C').length, top: abc(products).slice(0, 10).map(item => ({ name: item.name, class: item.class, ...(money ? { revenue: item.revenue } : {}), quantity: item.quantity })) },
      inventoryAdjustments: { count: adjustments.length, netQuantity: adjustmentNet, note: 'Diferença entre estoque teórico e contagem registrada pelos ajustes de inventário.' },
    };
    const alerts: Alert[] = [];
    if (risk.length > 0) alerts.push({ severity: risk.some(item => item.stock <= 0) ? 'critical' : 'warning', message: `${risk.length} insumo(s) em risco de ruptura: ${risk.slice(0, 5).map(item => item.name).join(', ')}.` });
    if (stale.length > 0) alerts.push({ severity: 'info', message: `${stale.length} insumo(s) com saldo e sem movimentação há mais de 30 dias.` });
    return result(ctx, period, {
      tool: 'stock.coverage', title: 'Estoque', source: 'Saldos (Ingredient/Product) e movimentações de estoque (StockMovement); consumo médio dos últimos 30 dias; vendas do período para a curva ABC', kind: 'MIXED', data,
      highlights: [`${coverage.length} insumo(s) acompanhado(s); ${risk.length} em risco (abaixo do mínimo ou cobertura < 3 dias).`, `${stale.length} parado(s) há mais de 30 dias.`, `Ajustes de inventário no período: ${adjustments.length} movimento(s), saldo líquido ${adjustmentNet}.`],
      alerts, limitations: ['A cobertura em dias usa o consumo registrado nos últimos 30 dias; sem consumo registrado a cobertura fica indefinida (não é inventada).', 'A curva ABC classifica produtos vendidos pelo faturamento do período.', money ? 'Valores monetários incluídos conforme a permissão do perfil.' : 'Valores monetários omitidos para o seu perfil.'],
      llmFacts: { ingredientsTracked: coverage.length, atRisk: data.atRisk.slice(0, 8), staleCount: stale.length, abc: { A: data.abc.A, B: data.abc.B, C: data.abc.C }, inventoryAdjustments: data.inventoryAdjustments },
    });
  },
};

const purchasingNeeds: ToolDef = {
  name: 'needs', description: 'Necessidade de compra, histórico de preços, lead time e comparação de fornecedores', parts: ['ingredients', 'stockMovements', 'purchases'],
  async run(ctx, period) {
    const settingsDefaultLead = 3; const safetyDays = 2;
    const [coverage, purchases] = await Promise.all([
      ingredientCoverage(ctx),
      prisma.purchaseOrder.findMany({ where: { ...tenantWhere(ctx), status: 'RECEIVED', createdAt: { gte: new Date(Date.now() - 180 * 86_400_000) } }, select: { createdAt: true, receivedAt: true, supplier: { select: { id: true, name: true } }, items: { select: { ingredientId: true, unitCost: true } } }, orderBy: { createdAt: 'asc' }, take: 5000 }),
    ]);
    const lead = new Map<string, { name: string; days: number[] }>(); const prices = new Map<string, { supplier: string; at: Date; cost: number }[]>();
    for (const purchase of purchases) {
      const entry = lead.get(purchase.supplier.id) ?? { name: purchase.supplier.name, days: [] };
      if (purchase.receivedAt) entry.days.push((purchase.receivedAt.getTime() - purchase.createdAt.getTime()) / 86_400_000); lead.set(purchase.supplier.id, entry);
      for (const item of purchase.items) prices.set(item.ingredientId, [...(prices.get(item.ingredientId) ?? []), { supplier: purchase.supplier.name, at: purchase.createdAt, cost: n(item.unitCost) }]);
    }
    const leadBySupplier = [...lead.values()].filter(row => row.days.length > 0).map(row => ({ supplier: row.name, averageLeadDays: r2(row.days.reduce((a, b) => a + b, 0) / row.days.length), samples: row.days.length })).sort((a, b) => a.averageLeadDays - b.averageLeadDays);
    const knownLead = leadBySupplier.length ? leadBySupplier.reduce((sum, row) => sum + row.averageLeadDays, 0) / leadBySupplier.length : null;
    const leadUsed = knownLead ?? settingsDefaultLead;
    const suggestions = coverage.filter(item => item.avgDailyConsumption > 0).map(item => ({ name: item.name, unit: item.unit, stock: item.stock, avgDailyConsumption: item.avgDailyConsumption, suggestedQuantity: Math.max(0, Math.round((item.avgDailyConsumption * (leadUsed + safetyDays) - item.stock) * 1000) / 1000) })).filter(item => item.suggestedQuantity > 0).sort((a, b) => b.suggestedQuantity - a.suggestedQuantity).slice(0, 20);
    const names = new Map(coverage.map(item => [item.id, item.name]));
    const priceChanges = [...prices.entries()].map(([id, list]) => { const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime()); const last = sorted[sorted.length - 1]; const before = sorted.length > 1 ? sorted[sorted.length - 2] : null; return { ingredient: names.get(id) ?? 'Insumo', lastUnitCost: r2(last.cost), supplier: last.supplier, previousUnitCost: before ? r2(before.cost) : null, changePercent: before && before.cost > 0 ? change(last.cost, before.cost) : null }; }).filter(item => item.changePercent !== null && Math.abs(item.changePercent) >= 5).sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!)).slice(0, 10);
    const comparison = [...prices.entries()].map(([id, list]) => { const bySupplier = new Map<string, number>(); for (const row of [...list].sort((a, b) => a.at.getTime() - b.at.getTime())) bySupplier.set(row.supplier, row.cost); return { ingredient: names.get(id) ?? 'Insumo', suppliers: [...bySupplier.entries()].map(([supplier, cost]) => ({ supplier, lastUnitCost: r2(cost) })).sort((a, b) => a.lastUnitCost - b.lastUnitCost) }; }).filter(item => item.suppliers.length >= 2).slice(0, 10);
    const data = { suggestions, leadTimeBySupplier: leadBySupplier, leadDaysUsed: r2(leadUsed), leadDaysSource: knownLead === null ? 'premissa (sem compras recebidas para medir)' : 'média medida das compras recebidas', safetyDays, priceChanges, supplierComparison: comparison, receivedPurchasesAnalyzed: purchases.length };
    return result(ctx, period, {
      tool: 'purchasing.needs', title: 'Compras e reposição', source: 'Consumo registrado (StockMovement), saldos (Ingredient) e compras recebidas (PurchaseOrder) dos últimos 180 dias', kind: 'ESTIMATE', data,
      highlights: [`${suggestions.length} insumo(s) com compra sugerida (consumo médio × (lead time + ${safetyDays} dia(s) de segurança) − saldo).`, `Lead time usado: ${r2(leadUsed)} dia(s) — ${data.leadDaysSource}.`, priceChanges[0] ? `Maior variação de preço: ${priceChanges[0].ingredient} ${pct(priceChanges[0].changePercent)}.` : 'Sem variações relevantes de preço nas compras recebidas.'],
      alerts: suggestions.length ? [{ severity: 'info', message: `Sugestões de compra são estimativas; nenhum pedido foi emitido.` }] : [],
      limitations: ['As quantidades são sugestões baseadas no consumo recente; nenhuma compra é criada ou confirmada sem autorização.', 'Só entram preços e prazos de compras com status Recebida.'],
      llmFacts: { suggestions: suggestions.slice(0, 8), leadDaysUsed: data.leadDaysUsed, priceChanges: priceChanges.slice(0, 5) },
    });
  },
};

const wasteSummary: ToolDef = {
  name: 'summary', description: 'Perdas registradas, descartes e diferenças de inventário', parts: ['stockMovements', 'ingredients'],
  async run(ctx, period) {
    const money = canSeeMoney(ctx);
    const [moves, ingredients, adjustments] = await Promise.all([
      prisma.stockMovement.findMany({ where: { ...tenantWhere(ctx), type: StockMovementType.WASTE, createdAt: { gte: period.from, lte: period.to } }, select: { ingredientId: true, quantity: true, unitCost: true, createdAt: true, note: true }, take: CAP }),
      prisma.ingredient.findMany({ where: tenantWhere(ctx), select: { id: true, name: true, unitOfMeasure: true, averageCost: true }, take: 5000 }),
      prisma.stockMovement.findMany({ where: { ...tenantWhere(ctx), type: StockMovementType.ADJUSTMENT, quantity: { lt: 0 }, createdAt: { gte: period.from, lte: period.to } }, select: { ingredientId: true, quantity: true, unitCost: true }, take: CAP }),
    ]);
    const info = new Map(ingredients.map(item => [item.id, item]));
    const cost = (move: { ingredientId: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal | null }) => { const unit = move.unitCost !== null ? n(move.unitCost) : n(info.get(move.ingredientId)?.averageCost); return { value: Math.abs(n(move.quantity)) * unit, estimated: move.unitCost === null }; };
    const byIngredient = new Map<string, { quantity: number; cost: number; estimatedCost: boolean }>();
    let total = 0; let anyEstimated = false;
    for (const move of moves) { const c = cost(move); total += c.value; anyEstimated ||= c.estimated; const row = byIngredient.get(move.ingredientId) ?? { quantity: 0, cost: 0, estimatedCost: false }; row.quantity += Math.abs(n(move.quantity)); row.cost += c.value; row.estimatedCost ||= c.estimated; byIngredient.set(move.ingredientId, row); }
    const unrecorded = adjustments.reduce((sum, move) => sum + cost(move).value, 0);
    const middle = new Date((period.from.getTime() + period.to.getTime()) / 2);
    const first = moves.filter(move => move.createdAt < middle).reduce((sum, move) => sum + cost(move).value, 0); const second = total - first;
    const data = {
      recordedWaste: { occurrences: moves.length, ...(money ? { estimatedCost: r2(total) } : {}), costBasis: anyEstimated ? 'parte do custo usa o custo médio atual do insumo (movimento sem custo registrado)' : 'custo registrado nos movimentos' },
      byIngredient: [...byIngredient.entries()].map(([id, row]) => ({ ingredient: info.get(id)?.name ?? 'Insumo', unit: info.get(id)?.unitOfMeasure ?? '', quantity: Math.round(row.quantity * 1000) / 1000, ...(money ? { cost: r2(row.cost) } : {}) })).sort((a, b) => b.quantity - a.quantity).slice(0, 10),
      inventoryShortfall: { occurrences: adjustments.length, ...(money ? { estimatedCost: r2(unrecorded) } : {}), note: 'Ajustes negativos de inventário: perda NÃO registrada como desperdício (estimativa).' },
      trend: { firstHalf: money ? r2(first) : null, secondHalf: money ? r2(second) : null, direction: moves.length < 4 ? 'dados insuficientes' : second > first * 1.1 ? 'aumentando' : second < first * 0.9 ? 'diminuindo' : 'estável' },
    };
    const alerts: Alert[] = data.trend.direction === 'aumentando' ? [{ severity: 'warning', message: 'O desperdício registrado aumentou na segunda metade do período.' }] : [];
    return result(ctx, period, {
      tool: 'waste.summary', title: 'Desperdícios', source: 'Movimentações de estoque do tipo perda (WASTE) e ajustes negativos de inventário', kind: 'MIXED', data,
      highlights: [`${moves.length} perda(s) registrada(s)${money ? ` com custo estimado de ${brl(total)}` : ''}.`, `${adjustments.length} ajuste(s) negativo(s) de inventário (perda não registrada, estimativa).`, `Tendência: ${data.trend.direction}.`],
      alerts, limitations: ['Perda registrada e diferença de inventário são mostradas separadamente; nenhum registro de perda é criado automaticamente.', 'O custo usa o custo do movimento quando existe, senão o custo médio atual do insumo (estimativa).'],
      llmFacts: { recorded: { occurrences: moves.length, cost: money ? r2(total) : null }, inventoryShortfallOccurrences: adjustments.length, trend: data.trend.direction, top: data.byIngredient.slice(0, 5).map(item => item.ingredient) },
    });
  },
};

// ---------------- PROFIT ----------------
const profitMargins: ToolDef = {
  name: 'margins', description: 'CMV, margem bruta, margem de contribuição, rentabilidade por produto e alertas de margem', parts: ['products', 'items', 'finance', 'settings'],
  async run(ctx, period) {
    const settings = await loadSettings(prisma, ctx.tenantId); const defaults = pricingDefaults(settings);
    const [products, items, expenses] = await Promise.all([
      prisma.product.findMany({ where: { ...tenantWhere(ctx), active: true, isCombo: false }, select: { id: true, name: true, price: true, cost: true, category: { select: { name: true } }, pricing: { select: { freightCost: true, otherAcquisitionCost: true, marginPercent: true, operationalCostPercent: true, operationalCostFixed: true, taxPercent: true, cardFeePercent: true, commissionPercent: true, otherVariablePercent: true } } }, take: 5000 }),
      prisma.orderItem.findMany({ where: { parentItemId: null, order: completed(ctx, period) }, select: { productId: true, total: true, quantity: true, weightKg: true, unitCost: true, order: { select: { channel: true } } }, take: CAP }),
      prisma.financialEntry.aggregate({ where: { ...tenantWhere(ctx), type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: period.from, lte: period.to } }, _sum: { paidAmount: true } }),
    ]);
    let revenue = 0; let revenueWithCost = 0; let cogs = 0; const byChannel = new Map<string, { revenue: number; cost: number; coveredRevenue: number }>(); const byProduct = new Map<string, { revenue: number; cost: number; units: number; coveredRevenue: number }>();
    for (const item of items) {
      const units = item.weightKg ? n(item.weightKg) * n(item.quantity) : n(item.quantity); const rev = n(item.total); revenue += rev;
      const channel = byChannel.get(item.order.channel) ?? { revenue: 0, cost: 0, coveredRevenue: 0 }; channel.revenue += rev;
      const row = byProduct.get(item.productId) ?? { revenue: 0, cost: 0, units: 0, coveredRevenue: 0 }; row.revenue += rev; row.units += units;
      if (item.unitCost !== null) { const cost = units * n(item.unitCost); revenueWithCost += rev; cogs += cost; channel.cost += cost; channel.coveredRevenue += rev; row.cost += cost; row.coveredRevenue += rev; }
      byChannel.set(item.order.channel, channel); byProduct.set(item.productId, row);
    }
    const variablePercent = defaults.taxPercent + defaults.cardFeePercent + defaults.commissionPercent + defaults.otherVariablePercent;
    const grossProfit = revenueWithCost - cogs; const contribution = grossProfit - revenueWithCost * variablePercent / 100;
    const names = new Map(products.map(product => [product.id, product.name]));
    const planned = products.filter(product => product.cost !== null && n(product.cost) > 0).map(product => ({ product, result: computePricing(effectiveInput(product, product.pricing, defaults)) })).filter((row): row is { product: typeof row.product; result: Extract<typeof row.result, { ok: true }> } => row.result.ok);
    const negative = planned.filter(row => row.result.status === 'NEGATIVE'); const below = planned.filter(row => row.result.status === 'BELOW_TARGET');
    const data = {
      period: { revenue: r2(revenue), revenueWithRegisteredCost: r2(revenueWithCost), costCoveragePercent: revenue > 0 ? r2(revenueWithCost / revenue * 100) : null, cmv: r2(cogs), cmvPercent: revenueWithCost > 0 ? r2(cogs / revenueWithCost * 100) : null,
        grossProfit: r2(grossProfit), grossMarginPercent: revenueWithCost > 0 ? r2(grossProfit / revenueWithCost * 100) : null,
        contributionMargin: r2(contribution), contributionMarginPercent: revenueWithCost > 0 ? r2(contribution / revenueWithCost * 100) : null, variableChargesPercentApplied: r2(variablePercent),
        expensesPaid: r2(n(expenses._sum.paidAmount)), operatingResultEstimate: r2(contribution - n(expenses._sum.paidAmount)) },
      definitions: { cmv: 'Custo congelado das mercadorias vendidas (custo no momento da venda).', grossMargin: '(Receita − CMV) ÷ Receita, só sobre itens com custo registrado.', contributionMargin: 'Margem bruta menos encargos variáveis percentuais padrão (tributos, cartão, comissão, outras) — ESTIMATIVA.', operatingResultEstimate: 'Contribuição menos despesas pagas no período: indicador gerencial, não é lucro contábil.' },
      byChannel: [...byChannel.entries()].map(([channel, row]) => ({ channel, revenue: r2(row.revenue), grossMarginPercent: row.coveredRevenue > 0 ? r2((row.coveredRevenue - row.cost) / row.coveredRevenue * 100) : null })),
      lowestRealizedMargins: [...byProduct.entries()].filter(([, row]) => row.coveredRevenue > 0).map(([id, row]) => ({ product: names.get(id) ?? 'Produto', revenue: r2(row.revenue), grossMarginPercent: r2((row.coveredRevenue - row.cost) / row.coveredRevenue * 100) })).sort((a, b) => a.grossMarginPercent - b.grossMarginPercent).slice(0, 8),
      planning: { analyzed: planned.length, negative: negative.length, belowTarget: below.length, negativeProducts: negative.slice(0, 10).map(row => ({ product: row.product.name, price: n(row.product.price), minimumPrice: Number(row.result.minimumPrice), recommendedPrice: Number(row.result.recommendedPrice) })), withoutCost: products.length - products.filter(product => product.cost !== null && n(product.cost) > 0).length },
    };
    const alerts: Alert[] = [];
    if (negative.length) alerts.push({ severity: 'critical', message: `${negative.length} produto(s) com preço abaixo do ponto de equilíbrio: ${negative.slice(0, 4).map(row => row.product.name).join(', ')}.` });
    if (below.length) alerts.push({ severity: 'warning', message: `${below.length} produto(s) abaixo da margem desejada.` });
    if (data.period.costCoveragePercent !== null && data.period.costCoveragePercent < 80) alerts.push({ severity: 'info', message: `Só ${pct(data.period.costCoveragePercent)} do faturamento tem custo registrado: margem e CMV cobrem apenas essa parte.` });
    return result(ctx, period, {
      tool: 'profit.margins', title: 'Lucro e rentabilidade', source: 'Itens vendidos com custo congelado (OrderItem.unitCost), formação de preço (motor de /pricing) e despesas pagas (FinancialEntry)', kind: 'MIXED', data,
      highlights: [`CMV ${brl(data.period.cmv)} (${pct(data.period.cmvPercent)} da receita com custo); margem bruta ${pct(data.period.grossMarginPercent)}; margem de contribuição estimada ${pct(data.period.contributionMarginPercent)}.`, `${negative.length} produto(s) abaixo do ponto de equilíbrio e ${below.length} abaixo da meta, entre ${planned.length} com custo cadastrado.`, 'Faturamento, margem e lucro são indicadores diferentes: veja as definições do painel.'],
      alerts, limitations: ['Itens sem custo registrado ficam fora do CMV e das margens (cobertura informada).', 'Lucro líquido contábil exige regime tributário e despesas fixas completos; aqui só há resultado operacional estimado.', 'Detalhe e simulação de preços: /pricing (formação de preço) e /profit (controle de lucro) — esta análise reaproveita o mesmo motor.'],
      llmFacts: { period: data.period, planning: { analyzed: planned.length, negative: negative.length, belowTarget: below.length } },
    });
  },
};

// ---------------- CUSTOMERS ----------------
const customersRfm: ToolDef = {
  name: 'rfm', description: 'Recência, frequência e valor; segmentação, recorrentes e inativos', parts: ['customers', 'orders'],
  async run(ctx, period) {
    const personal = MANAGEMENT_ROLES.includes(ctx.role); const money = canSeeMoney(ctx); const now = new Date();
    const [customers, sums] = await Promise.all([
      prisma.customer.findMany({ where: { tenantId: ctx.tenantId, active: true }, select: { id: true, name: true, marketingConsent: true }, take: 5000 }),
      prisma.order.groupBy({ by: ['customerId'], where: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: 'COMPLETED', customerId: { not: null } }, _count: true, _sum: { total: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
    ]);
    const stats = new Map<string, CustomerStats>(sums.map(row => [row.customerId!, { id: row.customerId!, orders: row._count, spent: n(row._sum.total), firstOrderAt: row._min.createdAt, lastOrderAt: row._max.createdAt }]));
    const all = customers.map(customer => stats.get(customer.id) ?? { id: customer.id, orders: 0, spent: 0, firstOrderAt: null, lastOrderAt: null });
    const average = averageSpent(all); const segments = new Map<string, number>(); const top: { name: string; spent: number; orders: number; segment: string }[] = [];
    for (const customer of customers) {
      const entry = stats.get(customer.id) ?? { id: customer.id, orders: 0, spent: 0, firstOrderAt: null, lastOrderAt: null }; const segment = classifyCustomer(entry, average, now);
      segments.set(segment, (segments.get(segment) ?? 0) + 1); if (entry.orders > 0) top.push({ name: customer.name, spent: r2(entry.spent), orders: entry.orders, segment });
    }
    const recent = all.filter(entry => entry.lastOrderAt && entry.lastOrderAt >= period.from).length;
    const data = {
      customers: customers.length, withOrders: all.filter(entry => entry.orders > 0).length, activeInPeriod: recent,
      // Spend-derived figures (average spent and the value-based segments) are financial information: only financial profiles receive them.
      ...(money ? { averageSpent: r2(average), segments: Object.fromEntries(segments) } : {}),
      withMarketingConsent: customers.filter(customer => customer.marketingConsent).length,
      topCustomers: personal && money ? top.sort((a, b) => b.spent - a.spent).slice(0, 10) : null,
      privacy: personal ? 'Nomes exibidos para perfil de gestão.' : 'Dados pessoais ocultos para o seu perfil: apenas totais agregados.',
      campaignHint: 'Campanhas só podem usar clientes com consentimento de marketing (LGPD); a segmentação detalhada está em /customers/segments.',
    };
    return result(ctx, period, {
      tool: 'customers.rfm', title: 'Clientes', source: 'Cadastro de clientes e pedidos concluídos vinculados (mesma regra de /customers/segments)', kind: 'FACT', data,
      highlights: [`${data.customers} cliente(s) ativo(s); ${data.withOrders} com compras; ${recent} compraram no período.`, money ? `Segmentos: ${[...segments.entries()].map(([name, count]) => `${name} ${count}`).join(', ') || 'sem segmentos'}.` : 'Segmentação por valor oculta para o seu perfil.', `${data.withMarketingConsent} cliente(s) com consentimento de marketing.`],
      alerts: [], limitations: ['Só pedidos vinculados a um cliente cadastrado entram na análise.', data.privacy],
      llmFacts: { customers: data.customers, withOrders: data.withOrders, activeInPeriod: recent, ...(money ? { segments: data.segments } : {}), withMarketingConsent: data.withMarketingConsent },
    });
  },
};

// ---------------- DELIVERY ----------------
const deliveryPerformance: ToolDef = {
  name: 'performance', description: 'Tempos por etapa, atrasos, cancelamentos e gargalos de delivery', parts: ['delivery', 'orders'],
  async run(ctx, period) {
    const settings = await loadSettings(prisma, ctx.tenantId); const lateMinutes = Math.max(settings.intelligence.delayedMinutes, 30);
    const jobs = await prisma.deliveryJob.findMany({ where: { ...tenantWhere(ctx), createdAt: { gte: period.from, lte: period.to } }, select: { status: true, createdAt: true, dispatchedAt: true, deliveredAt: true, courierName: true, order: { select: { createdAt: true } } }, take: CAP });
    const minutes = (from: Date | null | undefined, to: Date | null | undefined) => (from && to && to >= from ? (to.getTime() - from.getTime()) / 60_000 : null);
    const avg = (values: (number | null)[]) => { const real = values.filter((value): value is number => value !== null); return real.length ? { minutes: r2(real.reduce((a, b) => a + b, 0) / real.length), samples: real.length } : null; };
    const waiting = jobs.map(job => minutes(job.createdAt, job.dispatchedAt)); const onRoute = jobs.map(job => minutes(job.dispatchedAt, job.deliveredAt)); const total = jobs.map(job => minutes(job.order?.createdAt, job.deliveredAt));
    const stages = [{ stage: 'Espera até despacho', ...avg(waiting) }, { stage: 'Em rota até a entrega', ...avg(onRoute) }].filter((stage): stage is { stage: string; minutes: number; samples: number } => 'minutes' in stage && stage.minutes !== undefined);
    const late = total.filter((value): value is number => value !== null && value > lateMinutes).length;
    const byStatus = jobs.reduce<Record<string, number>>((acc, job) => ({ ...acc, [job.status]: (acc[job.status] ?? 0) + 1 }), {});
    const courier = new Map<string, number[]>(); jobs.forEach((job, index) => { const value = onRoute[index]; if (job.courierName && value !== null) courier.set(job.courierName, [...(courier.get(job.courierName) ?? []), value]); });
    const data = {
      jobs: jobs.length, byStatus, delivered: byStatus.DELIVERED ?? 0, cancelled: byStatus.CANCELLED ?? 0, cancellationRatePercent: jobs.length ? r2(((byStatus.CANCELLED ?? 0) / jobs.length) * 100) : null,
      averageWaitUntilDispatch: avg(waiting), averageRouteTime: avg(onRoute), averageTotalTime: avg(total), lateDeliveries: { threshold: lateMinutes, count: late, measured: total.filter(value => value !== null).length },
      bottleneck: stages.length ? stages.sort((a, b) => b.minutes - a.minutes)[0] : null, withoutTimestamps: jobs.filter(job => !job.dispatchedAt || (job.status === 'DELIVERED' && !job.deliveredAt)).length,
      byCourier: [...courier.entries()].map(([name, values]) => ({ courier: name, averageRouteMinutes: r2(values.reduce((a, b) => a + b, 0) / values.length), deliveries: values.length })).sort((a, b) => b.deliveries - a.deliveries).slice(0, 10),
    };
    const alerts: Alert[] = [];
    if (late > 0) alerts.push({ severity: 'warning', message: `${late} entrega(s) acima de ${lateMinutes} min do pedido à entrega.` });
    if (data.cancellationRatePercent !== null && data.cancellationRatePercent >= 10) alerts.push({ severity: 'warning', message: `Cancelamentos de delivery em ${pct(data.cancellationRatePercent)}.` });
    return result(ctx, period, {
      tool: 'delivery.performance', title: 'Delivery', source: 'Entregas (DeliveryJob) com os horários realmente registrados de pedido, despacho e entrega', kind: 'FACT', data,
      highlights: [`${jobs.length} entrega(s): ${data.delivered} entregue(s), ${data.cancelled} cancelada(s).`, data.averageTotalTime ? `Tempo médio do pedido à entrega: ${data.averageTotalTime.minutes} min (${data.averageTotalTime.samples} medida(s)).` : 'Sem entregas com horários completos para medir o tempo total.', data.bottleneck ? `Maior etapa: ${data.bottleneck.stage} (${data.bottleneck.minutes} min em média).` : 'Sem dados para identificar gargalo.'],
      alerts, limitations: ['Tempos só são calculados quando os horários existem; entregas sem horários ficam fora da média (contadas em "sem registro").', 'Nenhuma localização ou tempo é estimado.'],
      llmFacts: { jobs: jobs.length, byStatus, stages, late: data.lateDeliveries, cancellationRatePercent: data.cancellationRatePercent },
    });
  },
};

// ---------------- PRODUCTION ----------------
const productionFlow: ToolDef = {
  name: 'flow', description: 'Fila por setor, tempo de preparo, pedidos atrasados e produtividade', parts: ['items', 'orders', 'settings'],
  async run(ctx, period) {
    const settings = await loadSettings(prisma, ctx.tenantId); const delayed = settings.intelligence.delayedMinutes;
    const [sectors, queue, readyItems, delayedOrders] = await Promise.all([
      prisma.productionSector.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true } }),
      prisma.orderItem.findMany({ where: { status: { in: ['PENDING', 'PREPARING'] }, parentItemId: null, order: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: { in: ['OPEN', 'PREPARING'] } } }, select: { sectorId: true, createdAt: true }, take: CAP }),
      prisma.orderItem.findMany({ where: { status: 'READY', parentItemId: null, createdAt: { gte: period.from, lte: period.to }, order: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}) } }, select: { sectorId: true, createdAt: true, updatedAt: true, productId: true }, take: CAP }),
      prisma.order.count({ where: { tenantId: ctx.tenantId, ...(ctx.unitId ? { unitId: ctx.unitId } : {}), status: { in: ['OPEN', 'PREPARING'] }, createdAt: { lt: new Date(Date.now() - delayed * 60_000) } } }),
    ]);
    const name = new Map(sectors.map(sector => [sector.id, sector.name]));
    const queueBySector = new Map<string, { items: number; oldest: Date }>(); for (const item of queue) { const key = item.sectorId ?? 'none'; const row = queueBySector.get(key) ?? { items: 0, oldest: item.createdAt }; row.items++; if (item.createdAt < row.oldest) row.oldest = item.createdAt; queueBySector.set(key, row); }
    const prep = new Map<string, number[]>(); for (const item of readyItems) { const minutes = (item.updatedAt.getTime() - item.createdAt.getTime()) / 60_000; if (minutes >= 0 && minutes < 600) prep.set(item.sectorId ?? 'none', [...(prep.get(item.sectorId ?? 'none') ?? []), minutes]); }
    const sectorRows = [...new Set([...queueBySector.keys(), ...prep.keys()])].map(key => { const values = prep.get(key) ?? []; return { sector: key === 'none' ? 'Sem setor' : name.get(key) ?? 'Setor removido', queuedItems: queueBySector.get(key)?.items ?? 0, oldestWaitingMinutes: queueBySector.get(key) ? Math.round((Date.now() - queueBySector.get(key)!.oldest.getTime()) / 60_000) : null, averagePrepMinutes: values.length ? r2(values.reduce((a, b) => a + b, 0) / values.length) : null, itemsReady: values.length }; }).sort((a, b) => b.queuedItems - a.queuedItems);
    const data = { delayedOrders: { count: delayedOrders, thresholdMinutes: delayed }, sectors: sectorRows, itemsInQueue: queue.length, itemsReadyInPeriod: readyItems.length, itemsPerDay: r2(readyItems.length / daysBetween(period)), bottleneckSector: sectorRows.find(row => row.queuedItems > 0) ?? null };
    const alerts: Alert[] = delayedOrders ? [{ severity: 'critical', message: `${delayedOrders} pedido(s) em produção há mais de ${delayed} min.` }] : [];
    return result(ctx, period, {
      tool: 'production.flow', title: 'Produção', source: 'Itens de pedido (OrderItem) por setor de produção: criação e última atualização de status', kind: 'FACT', data,
      highlights: [`${queue.length} item(ns) na fila agora; ${delayedOrders} pedido(s) atrasado(s) (> ${delayed} min).`, data.bottleneckSector ? `Maior fila: ${data.bottleneckSector.sector} (${data.bottleneckSector.queuedItems} item(ns)).` : 'Fila vazia.', `${readyItems.length} item(ns) concluído(s) no período (${data.itemsPerDay}/dia).`],
      alerts, limitations: ['O tempo de preparo é a diferença entre a criação do item e a última atualização do status "pronto" (aproximação: o sistema não registra o início do preparo por item).', 'Esta análise é somente de leitura: não altera status de pedidos.'],
      llmFacts: { queue: queue.length, delayedOrders: data.delayedOrders, sectors: sectorRows.slice(0, 6) },
    });
  },
};

// ---------------- MANAGEMENT (multi-unit table) ----------------
const managementUnits: ToolDef = {
  name: 'units', description: 'Comparação entre unidades autorizadas', parts: ['orders'],
  async run(ctx, period) {
    const prev = previousPeriod(period);
    const [units, current, before] = await Promise.all([
      prisma.unit.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true } }),
      prisma.order.groupBy({ by: ['unitId'], where: { tenantId: ctx.tenantId, status: 'COMPLETED', createdAt: { gte: period.from, lte: period.to } }, _sum: { total: true }, _count: true }),
      prisma.order.groupBy({ by: ['unitId'], where: { tenantId: ctx.tenantId, status: 'COMPLETED', createdAt: { gte: prev.from, lte: prev.to } }, _sum: { total: true } }),
    ]);
    const name = new Map(units.map(unit => [unit.id, unit.name])); const previous = new Map(before.map(row => [row.unitId, n(row._sum.total)]));
    const rows = current.map(row => ({ unit: row.unitId ? name.get(row.unitId) ?? 'Unidade removida' : 'Sem unidade', revenue: r2(n(row._sum.total)), orders: row._count, previousRevenue: r2(previous.get(row.unitId) ?? 0), changePercent: change(n(row._sum.total), previous.get(row.unitId) ?? 0) })).sort((a, b) => b.revenue - a.revenue);
    return result(ctx, period, { tool: 'management.units', title: 'Comparação entre unidades', source: 'Pedidos concluídos por unidade', kind: 'FACT', data: { units: rows }, highlights: rows.slice(0, 3).map(row => `${row.unit}: ${brl(row.revenue)} em ${row.orders} venda(s).`), alerts: [], limitations: ['Visível apenas para perfis de gestão sem unidade fixa.'], llmFacts: { units: rows } });
  },
};

export const TOOLS = { financeOverview, salesSummary, stockCoverage, purchasingNeeds, wasteSummary, profitMargins, customersRfm, deliveryPerformance, productionFlow, managementUnits };
export type { ToolResult };
