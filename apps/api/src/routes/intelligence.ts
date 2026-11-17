import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, type TenantSettingsData } from '../lib/settings';
import { requireAuth, requireTenant } from '../middleware/auth';
import { tenantScope } from '../lib/report-helpers';
import { localParts } from '../lib/scheduling';
import { addDays, analyzeSales, brl, detectIntent, extractAmount, forecastRevenue, goalProgress, weeklyTrend, type Sale } from '../lib/intelligence';

export const intelligenceRoutes = Router();
intelligenceRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

type Alert = { key: string; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; href: string };
const n = (value: Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

// UTC instant of local midnight of a calendar day in the tenant time zone.
function localMidnight(day: string, timeZone: string): Date {
  const noon = new Date(`${day}T12:00:00Z`);
  const offsetMinutes = localParts(noon, timeZone).minutes - 720;
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) - offsetMinutes * 60_000);
}

async function loadInsights(scope: ReturnType<typeof tenantScope>, settings: TenantSettingsData, now = new Date()) {
  const tz = settings.hours.timezone;
  const config = settings.intelligence;
  const today = localParts(now, tz).day;
  const monthStart = localMidnight(`${today.slice(0, 7)}-01`, tz);
  const previousMonthStart = localMidnight(`${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, tz);
  const since90 = localMidnight(addDays(today, -90), tz);
  const since30 = localMidnight(addDays(today, -30), tz);
  const completed = { ...scope, status: OrderStatus.COMPLETED };
  const delayedBefore = new Date(now.getTime() - config.delayedMinutes * 60_000);
  const payableLimit = new Date(now.getTime() + config.payableDays * 86_400_000);

  const [orders, soldMonth, sold30, products, expenseEntries, wasteMoves, ingredients, payables, receivables, delayed, cashSessions] = await Promise.all([
    prisma.order.findMany({ where: { ...completed, createdAt: { gte: since90 } }, select: { createdAt: true, total: true, channel: true, createdByUserId: true }, orderBy: { createdAt: 'desc' }, take: 50_000 }),
    prisma.orderItem.groupBy({ by: ['productId'], where: { order: { ...completed, createdAt: { gte: monthStart } } }, _sum: { quantity: true, total: true } }),
    prisma.orderItem.groupBy({ by: ['productId'], where: { order: { ...completed, createdAt: { gte: since30 } } }, _sum: { quantity: true, total: true } }),
    prisma.product.findMany({ where: { ...scope }, select: { id: true, name: true, price: true, cost: true, active: true, isCombo: true } }),
    prisma.financialEntry.findMany({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: previousMonthStart } }, select: { category: true, paidAmount: true, amount: true, settledAt: true } }),
    prisma.stockMovement.findMany({ where: { ...scope, type: 'WASTE', createdAt: { gte: since30 } }, select: { quantity: true, unitCost: true, ingredient: { select: { name: true, averageCost: true } } } }),
    prisma.ingredient.findMany({ where: { ...scope, active: true, minimumStock: { not: null } }, select: { id: true, name: true, unitOfMeasure: true, currentStock: true, minimumStock: true } }),
    prisma.financialEntry.findMany({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.OPEN, dueAt: { lte: payableLimit } }, select: { amount: true, paidAmount: true, dueAt: true } }),
    prisma.financialEntry.findMany({ where: { ...scope, type: FinancialEntryType.INCOME, status: FinancialEntryStatus.OPEN, dueAt: { lt: now } }, select: { amount: true, paidAmount: true } }),
    prisma.order.count({ where: { ...scope, status: { in: [OrderStatus.OPEN, OrderStatus.PREPARING] }, createdAt: { lt: delayedBefore, gte: since30 } } }),
    prisma.cashSession.findMany({ where: { ...scope, status: 'CLOSED', closedAt: { gte: since30 } }, select: { expectedAmount: true, closingAmount: true } }),
  ]);

  const sales: Sale[] = orders.map(order => ({ at: order.createdAt, total: n(order.total), channel: order.channel, userId: order.createdByUserId }));
  const analysis = analyzeSales(sales, now, tz);
  const productById = new Map(products.map(product => [product.id, product]));

  // Cost of goods only covers products with a registered cost; coverage tells how much of the revenue that represents.
  let revenueWithCost = 0; let cogs = 0; let itemRevenue = 0;
  for (const row of soldMonth) {
    const product = productById.get(row.productId);
    const revenue = n(row._sum.total);
    itemRevenue += revenue;
    if (product?.cost && !product.isCombo) { revenueWithCost += revenue; cogs += n(product.cost) * n(row._sum.quantity); }
  }
  const ranked = sold30.map(row => ({ productId: row.productId, name: productById.get(row.productId)?.name ?? 'Produto removido', quantity: n(row._sum.quantity), revenue: round2(n(row._sum.total)) })).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue);
  const soldIds = new Set(sold30.map(row => row.productId));
  const lessSold = products.filter(product => product.active && !product.isCombo).map(product => ({ name: product.name, quantity: n(sold30.find(row => row.productId === product.id)?._sum.quantity) })).sort((a, b) => a.quantity - b.quantity).slice(0, 5);
  const margins = products.filter(product => product.active && !product.isCombo && product.cost && n(product.price) > 0).map(product => ({ name: product.name, price: n(product.price), cost: n(product.cost), marginPercent: round2(((n(product.price) - n(product.cost)) / n(product.price)) * 100), marginValue: round2(n(product.price) - n(product.cost)), sold: soldIds.has(product.id) }));

  const monthKey = today.slice(0, 7); const previousKey = addDays(`${monthKey}-01`, -1).slice(0, 7);
  const expenseByCategory = new Map<string, { current: number; previous: number }>();
  let expensesCurrent = 0; let expensesPrevious = 0;
  for (const entry of expenseEntries) {
    const value = n(entry.paidAmount) || n(entry.amount);
    const day = entry.settledAt ? localParts(entry.settledAt, tz).day : '';
    const bucket = day.startsWith(monthKey) ? 'current' : day.startsWith(previousKey) ? 'previous' : null;
    if (!bucket) continue;
    const category = entry.category ?? 'Sem categoria';
    const row = expenseByCategory.get(category) ?? { current: 0, previous: 0 };
    row[bucket] += value; expenseByCategory.set(category, row);
    if (bucket === 'current') expensesCurrent += value; else expensesPrevious += value;
  }
  const wasteCost = round2(wasteMoves.reduce((sum, move) => sum + Math.abs(n(move.quantity)) * (n(move.unitCost) || n(move.ingredient.averageCost)), 0));
  const lowStock = ingredients.filter(item => n(item.currentStock) <= n(item.minimumStock)).map(item => ({ name: item.name, unit: item.unitOfMeasure, current: n(item.currentStock), minimum: n(item.minimumStock) }));
  const openPayables = payables.map(entry => ({ value: n(entry.amount) - n(entry.paidAmount), overdue: Boolean(entry.dueAt && entry.dueAt < now) }));
  const divergences = cashSessions.filter(session => session.expectedAmount !== null && session.closingAmount !== null && Math.abs(n(session.expectedAmount) - n(session.closingAmount)) >= 0.01);
  const forecast = forecastRevenue(analysis, now, tz);
  const trend = weeklyTrend(analysis, now, tz);
  const bestUsers = analysis.byUser.slice(0, 3);
  const users = bestUsers.length ? await prisma.user.findMany({ where: { id: { in: bestUsers.map(user => user.userId) }, tenantId: scope.tenantId }, select: { id: true, name: true } }) : [];

  const monthReceipts = { revenue: analysis.monthToDate, revenueWithCost: round2(revenueWithCost), cogs: round2(cogs), grossProfit: round2(revenueWithCost - cogs), coverage: itemRevenue > 0 ? round2((revenueWithCost / itemRevenue) * 100) : 0, expensesPaid: round2(expensesCurrent), operatingResult: round2(analysis.monthToDate - expensesCurrent) };

  const alerts: Alert[] = [];
  const on = config.alerts;
  if (on.salesDrop && trend && trend.changePercent <= -config.salesDropPercent) alerts.push({ key: 'sales-drop', severity: 'critical', title: 'Queda nas vendas', detail: `Os últimos 7 dias faturaram ${brl(trend.last7)}, ${Math.abs(trend.changePercent)}% a menos que os 7 dias anteriores (${brl(trend.previous7)}).`, href: '/reports?r=sales' });
  if (on.lowStock && lowStock.length > 0) alerts.push({ key: 'low-stock', severity: 'warning', title: `${lowStock.length} item(ns) com estoque crítico`, detail: lowStock.slice(0, 5).map(item => `${item.name} (${item.current} ${item.unit}, mínimo ${item.minimum})`).join('; '), href: '/inventory' });
  const overduePayables = openPayables.filter(item => item.overdue);
  if (on.payables && openPayables.length > 0) alerts.push({ key: 'payables', severity: overduePayables.length > 0 ? 'critical' : 'warning', title: overduePayables.length > 0 ? `${overduePayables.length} conta(s) a pagar vencida(s)` : `${openPayables.length} conta(s) a pagar vencem em até ${config.payableDays} dia(s)`, detail: `Total em aberto: ${brl(openPayables.reduce((sum, item) => sum + item.value, 0))}.`, href: '/financial?type=EXPENSE' });
  if (on.receivables && receivables.length > 0) alerts.push({ key: 'receivables', severity: 'warning', title: `${receivables.length} conta(s) a receber vencida(s)`, detail: `Total em atraso: ${brl(receivables.reduce((sum, item) => sum + n(item.amount) - n(item.paidAmount), 0))}.`, href: '/financial?type=INCOME' });
  const lowMargins = margins.filter(item => item.marginPercent < config.marginFloorPercent);
  if (on.lowMargin && config.marginFloorPercent > 0 && lowMargins.length > 0) alerts.push({ key: 'low-margin', severity: 'warning', title: `${lowMargins.length} produto(s) com margem abaixo de ${config.marginFloorPercent}%`, detail: lowMargins.slice(0, 5).map(item => `${item.name} (${item.marginPercent}%)`).join('; '), href: '/reports?r=profit-margin' });
  if (on.delayedOrders && delayed > 0) alerts.push({ key: 'delayed-orders', severity: 'critical', title: `${delayed} pedido(s) atrasado(s)`, detail: `Pedidos abertos há mais de ${config.delayedMinutes} minutos.`, href: '/monitor' });
  if (on.cashDivergence && divergences.length > 0) alerts.push({ key: 'cash-divergence', severity: 'warning', title: `${divergences.length} fechamento(s) de caixa com divergência`, detail: 'Nos últimos 30 dias o valor contado difere do esperado.', href: '/reports?r=cash-closings' });
  if (on.waste && wasteCost > 0) alerts.push({ key: 'waste', severity: 'info', title: 'Desperdício registrado', detail: `Perdas de ${brl(wasteCost)} em 30 dias, valorizadas pelo custo registrado.`, href: '/inventory' });

  return { now, tz, config, analysis, forecast, trend, ranked, lessSold, margins, month: monthReceipts, expenses: { current: round2(expensesCurrent), previous: round2(expensesPrevious), byCategory: [...expenseByCategory.entries()].map(([category, value]) => ({ category, current: round2(value.current), previous: round2(value.previous) })) }, wasteCost, lowStock, alerts, topEmployees: bestUsers.map(user => ({ ...user, name: users.find(item => item.id === user.userId)?.name ?? 'Usuário removido' })), truncated: orders.length >= 50_000 };
}
type Insights = Awaited<ReturnType<typeof loadInsights>>;

const publicAnalysis = (insights: Insights) => {
  const { dayTotals: _days, ...rest } = insights.analysis;
  return rest;
};

intelligenceRoutes.get('/summary', async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const settings = await loadSettings(prisma, scope.tenantId);
    const insights = await loadInsights(scope, settings);
    const goal = insights.config.monthlyGoal > 0 ? goalProgress(insights.analysis.monthToDate, insights.config.monthlyGoal, insights.now, insights.tz) : null;
    return res.json({
      generatedAt: insights.now, historyDays: 90, truncated: insights.truncated,
      sales: publicAnalysis(insights), trend: insights.trend, goal,
      forecast: insights.forecast, forecastNote: insights.forecast ? 'Valores previstos são estimativas baseadas no histórico; não são resultado efetivo.' : 'Histórico insuficiente: são necessários ao menos 14 dias com vendas para estimar.',
      month: insights.month, topProducts: insights.ranked.slice(0, 5), lessSold: insights.lessSold,
      topMargins: [...insights.margins].sort((a, b) => b.marginPercent - a.marginPercent).slice(0, 5),
      expenses: insights.expenses, wasteCost: insights.wasteCost, topEmployees: insights.topEmployees, alerts: insights.alerts, alertConfig: insights.config,
    });
  } catch (error) { return next(error); }
});

const channelLabel: Record<string, string> = { POS: 'PDV', TABLE: 'Mesa / QR Code', DELIVERY: 'Delivery', TAKEAWAY: 'Retirada', WHATSAPP: 'WhatsApp' };

function answer(intent: ReturnType<typeof detectIntent>, insights: Insights, question: string): { answer: string; limitations: string[] } {
  const { analysis, month } = insights;
  const noSales = analysis.daysWithSales === 0;
  const limitations: string[] = [];
  const insufficient = (text: string) => ({ answer: text, limitations });
  switch (intent) {
    case 'SALES_TODAY': return insufficient(`Hoje foram concluídos ${analysis.ordersToday} pedido(s), somando ${brl(analysis.today)} em faturamento.`);
    case 'SALES_YESTERDAY': return insufficient(`Ontem o faturamento de pedidos concluídos foi ${brl(analysis.yesterday)}.`);
    case 'SALES_MONTH': return insufficient(`No mês até hoje: ${brl(analysis.monthToDate)} em ${analysis.ordersMonth} pedido(s) concluído(s).`);
    case 'AVG_TICKET': return insufficient(analysis.avgTicketMonth === null ? 'Ainda não há pedidos concluídos neste mês para calcular o ticket médio.' : `O ticket médio do mês é ${brl(analysis.avgTicketMonth)} (${analysis.ordersMonth} pedidos).`);
    case 'PROFIT': {
      limitations.push('Faturamento não é lucro. O custo considera apenas produtos com custo cadastrado.', `Cobertura do custo: ${month.coverage}% do faturamento dos itens vendidos no mês.`);
      return insufficient(`Faturamento do mês: ${brl(month.revenue)}. Lucro bruto estimado (apenas produtos com custo): ${brl(month.grossProfit)}. Despesas pagas no mês: ${brl(month.expensesPaid)}. Resultado operacional (faturamento − despesas pagas): ${brl(month.operatingResult)}.`);
    }
    case 'BEST_DAY': return insufficient(analysis.bestDay ? `O melhor dia dos últimos 90 dias foi ${analysis.bestDay.day.split('-').reverse().join('/')}, com ${brl(analysis.bestDay.total)}.` : 'Ainda não há vendas concluídas nos últimos 90 dias.');
    case 'TOP_PRODUCTS': return insufficient(insights.ranked.length ? `Mais vendidos nos últimos 30 dias: ${insights.ranked.slice(0, 5).map((item, index) => `${index + 1}. ${item.name} (${item.quantity} un., ${brl(item.revenue)})`).join('; ')}.` : 'Sem vendas nos últimos 30 dias para ranquear produtos.');
    case 'WORST_PRODUCTS': return insufficient(insights.lessSold.length ? `Produtos ativos com menos saída em 30 dias: ${insights.lessSold.map(item => `${item.name} (${item.quantity} un.)`).join('; ')}.` : 'Não há produtos ativos cadastrados.');
    case 'BEST_MARGIN': {
      const top = [...insights.margins].sort((a, b) => b.marginPercent - a.marginPercent).slice(0, 5);
      limitations.push('Somente produtos com custo cadastrado entram no cálculo de margem.');
      return insufficient(top.length ? `Maiores margens: ${top.map(item => `${item.name} (${item.marginPercent}%, ${brl(item.marginValue)} por unidade)`).join('; ')}.` : 'Nenhum produto tem custo cadastrado, então não é possível calcular margens. Cadastre o custo ou a ficha técnica.');
    }
    case 'EXPENSES': {
      const rows = insights.expenses.byCategory.filter(item => item.previous > 0 && item.current > item.previous).sort((a, b) => (b.current - b.previous) - (a.current - a.previous));
      limitations.push('Considera somente despesas com pagamento registrado (contas pagas).');
      return insufficient(insights.expenses.byCategory.length === 0 ? 'Não há despesas pagas registradas neste mês nem no anterior.' : `Despesas pagas: ${brl(insights.expenses.current)} no mês contra ${brl(insights.expenses.previous)} no mês anterior. ${rows.length ? `Categorias que aumentaram: ${rows.slice(0, 5).map(item => `${item.category} (${brl(item.previous)} → ${brl(item.current)})`).join('; ')}.` : 'Nenhuma categoria aumentou em relação ao mês anterior.'}`);
    }
    case 'WASTE': limitations.push('Só contabiliza perdas lançadas como “Perda/Desperdício” no estoque.'); return insufficient(insights.wasteCost > 0 ? `Nos últimos 30 dias foram registradas perdas de ${brl(insights.wasteCost)}.` : 'Não há perdas registradas nos últimos 30 dias.');
    case 'TOP_EMPLOYEE': return insufficient(insights.topEmployees.length ? `Quem mais vendeu nos últimos 90 dias: ${insights.topEmployees.map((item, index) => `${index + 1}. ${item.name} (${item.orders} pedidos, ${brl(item.total)})`).join('; ')}.` : 'Nenhum pedido concluído tem responsável registrado.');
    case 'GOAL': {
      const goal = extractAmount(question) ?? (insights.config.monthlyGoal > 0 ? insights.config.monthlyGoal : null);
      if (!goal) return insufficient('Informe o valor da meta na pergunta (ex.: “meta de 50.000”) ou cadastre a meta mensal em RM Inteligência.');
      const progress = goalProgress(analysis.monthToDate, goal, insights.now, insights.tz);
      return insufficient(progress.reached ? `A meta de ${brl(goal)} já foi alcançada: faturamento do mês em ${brl(progress.monthToDate)}.` : `Para a meta de ${brl(goal)} faltam ${brl(progress.missing)}. Restam ${progress.remainingDays} dia(s) no mês, ou seja, cerca de ${brl(progress.perDay)} por dia.`);
    }
    case 'RESTOCK': return insufficient(insights.lowStock.length ? `Itens abaixo do estoque mínimo: ${insights.lowStock.slice(0, 10).map(item => `${item.name} (${item.current} ${item.unit}, mínimo ${item.minimum})`).join('; ')}.` : 'Nenhum insumo com estoque mínimo configurado está abaixo do mínimo.');
    case 'PERFORMANCE': return insufficient(analysis.monthChangePercent === null ? `Faturamento do mês: ${brl(analysis.monthToDate)}. Não há vendas do mês anterior no mesmo período para comparar.` : `Faturamento do mês até hoje: ${brl(analysis.monthToDate)} contra ${brl(analysis.previousMonthSamePeriod)} no mesmo período do mês anterior (${analysis.monthChangePercent >= 0 ? '+' : ''}${analysis.monthChangePercent}%).`);
    case 'FORECAST': {
      if (!insights.forecast) return insufficient('Ainda não há histórico suficiente (mínimo de 14 dias com vendas) para estimar o faturamento.');
      limitations.push('Valores previstos são estimativas, não resultado efetivo.');
      return insufficient(`Estimativa para o mês: ${brl(insights.forecast.monthProjection)} (já realizado: ${brl(analysis.monthToDate)}). Média diária recente: ${brl(insights.forecast.dailyAverage)}. Base: ${insights.forecast.basis}.`);
    }
    case 'CHANNELS': return insufficient(analysis.byChannel.length ? `Vendas por canal (90 dias): ${analysis.byChannel.map(item => `${channelLabel[item.channel] ?? item.channel}: ${brl(item.total)} (${item.share}%)`).join('; ')}.` : 'Sem vendas concluídas para comparar canais.');
    case 'PEAK_HOURS': return insufficient(analysis.peakHours.length ? `Horários de maior movimento (90 dias): ${analysis.peakHours.map(item => `${String(item.hour).padStart(2, '0')}h (${item.orders} pedidos)`).join(', ')}.` : 'Sem vendas concluídas para identificar horários.');
    default: return { answer: noSales ? 'Ainda não há vendas concluídas para analisar.' : 'Não consegui interpretar a pergunta. Posso responder sobre vendas de hoje/ontem/mês, lucro estimado, melhor dia, produtos mais e menos vendidos, margens, despesas, perdas, quem mais vendeu, ticket médio, meta, reposição de estoque, previsão, canais e horários de pico.', limitations };
  }
}

intelligenceRoutes.post('/ask', async (req, res, next) => {
  try {
    const input = z.object({ question: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Escreva uma pergunta de 3 a 300 caracteres' });
    const scope = tenantScope(req);
    const settings = await loadSettings(prisma, scope.tenantId);
    const insights = await loadInsights(scope, settings);
    const intent = detectIntent(input.data.question);
    const result = answer(intent, insights, input.data.question);
    return res.json({ intent, ...result, source: 'Dados registrados do próprio estabelecimento; nenhuma IA externa é usada.', generatedAt: insights.now });
  } catch (error) { return next(error); }
});
