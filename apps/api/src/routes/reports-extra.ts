import { Router } from 'express';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { prisma } from '../lib/prisma';
import { loadSettings } from '../lib/settings';
import { effectiveUnitPrice } from '../lib/promotions';
import { D, dayKey, finalizeReport, formatDay, parsePeriod, percentOf, reportToCsv, sumDecimals, tenantScope } from '../lib/report-helpers';
import type { ReportBody, ReportColumn } from '../lib/report-helpers';

// Tabular reports ("Central de relatórios"): every kind returns the same shape so the UI and CSV export are generic.
export const reportsExtraRoutes = Router();
reportsExtraRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

type Ctx = { tenantId: string; scope: { tenantId: string; unitId?: string }; from: Date; to: Date; tz: string; now: Date; query: Request['query'] };

const CHANNEL_LABEL: Record<string, string> = { POS: 'Balcão/PDV', DELIVERY: 'Entrega', TAKEAWAY: 'Retirada', WHATSAPP: 'WhatsApp', TABLE: 'Mesa' };
const STATUS_LABEL: Record<string, string> = { OPEN: 'Aberto', PREPARING: 'Em preparo', READY: 'Pronto', COMPLETED: 'Finalizado', CANCELLED: 'Cancelado' };
const METHOD_LABEL: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito', DEBIT_CARD: 'Cartão de débito', VOUCHER: 'Vale/Voucher', OTHER: 'Outros' };
const ROW_LIMIT = 5000;
const ITEM_LIMIT = 50000;
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (key: string, label: string): ReportColumn => ({ key, label, type: 'text' });
const money = (key: string, label: string): ReportColumn => ({ key, label, type: 'money' });
const num = (key: string, label: string): ReportColumn => ({ key, label, type: 'number' });
const pct = (key: string, label: string): ReportColumn => ({ key, label, type: 'percent' });
const when = (key: string, label: string): ReportColumn => ({ key, label, type: 'datetime' });

const salesWhere = (ctx: Ctx) => ({ ...ctx.scope, createdAt: { gte: ctx.from, lte: ctx.to }, status: { not: 'CANCELLED' as const } });

// Order lines of the period sales; combo components (parentItemId) are kept so callers decide how to treat them.
async function loadItems(ctx: Ctx) {
  return prisma.orderItem.findMany({
    where: { status: { not: 'CANCELLED' }, order: salesWhere(ctx) },
    select: {
      productId: true, quantity: true, weightKg: true, unitPrice: true, total: true, parentItemId: true,
      product: { select: { name: true, price: true, cost: true, isCombo: true, category: { select: { name: true } } } },
      order: { select: { createdAt: true } },
    },
    take: ITEM_LIMIT,
  });
}

const unitsOf = (item: { quantity: number; weightKg: Prisma.Decimal | null }) => (item.weightKg ? item.weightKg.mul(item.quantity) : D(item.quantity));

type OrderSums = { subtotal: Prisma.Decimal; discount: Prisma.Decimal; serviceFee: Prisma.Decimal; deliveryFee: Prisma.Decimal; couvertFee: Prisma.Decimal; total: Prisma.Decimal };
const sumOrders = (orders: OrderSums[]) => ({
  subtotal: sumDecimals(orders.map(o => o.subtotal)), discount: sumDecimals(orders.map(o => o.discount)), serviceFee: sumDecimals(orders.map(o => o.serviceFee)),
  deliveryFee: sumDecimals(orders.map(o => o.deliveryFee)), couvertFee: sumDecimals(orders.map(o => o.couvertFee)), total: sumDecimals(orders.map(o => o.total)),
});

async function sales(ctx: Ctx): Promise<ReportBody> {
  const orders = await prisma.order.findMany({
    where: salesWhere(ctx), orderBy: { createdAt: 'asc' }, take: ROW_LIMIT + 1,
    select: { number: true, code: true, createdAt: true, channel: true, status: true, customerName: true, subtotal: true, discount: true, serviceFee: true, deliveryFee: true, couvertFee: true, total: true },
  });
  const truncated = orders.length > ROW_LIMIT;
  const list = truncated ? orders.slice(0, ROW_LIMIT) : orders;
  const totals = sumOrders(list);
  if (ctx.query.groupBy === 'day') {
    const byDay = new Map<string, typeof list>();
    for (const order of list) {
      const key = dayKey(order.createdAt, ctx.tz);
      byDay.set(key, [...(byDay.get(key) ?? []), order]);
    }
    const rows = [...byDay.entries()].map(([day, group]) => {
      const sums = sumOrders(group);
      return { day: formatDay(day), orders: group.length, ...sums, average: group.length ? sums.total.div(group.length).toDecimalPlaces(2) : D(0) };
    });
    return {
      columns: [text('day', 'Dia'), num('orders', 'Pedidos'), money('subtotal', 'Subtotal'), money('discount', 'Descontos'), money('serviceFee', 'Taxa de serviço'), money('deliveryFee', 'Entrega'), money('couvertFee', 'Couvert'), money('total', 'Total'), money('average', 'Ticket médio')],
      rows, totals: { day: 'Total', orders: list.length, ...totals, average: list.length ? totals.total.div(list.length).toDecimalPlaces(2) : D(0) }, truncated,
    };
  }
  return {
    columns: [num('number', 'Nº'), text('code', 'Código'), when('createdAt', 'Data'), text('channel', 'Canal'), text('status', 'Situação'), text('customer', 'Cliente'), money('subtotal', 'Subtotal'), money('discount', 'Descontos'), money('serviceFee', 'Taxa de serviço'), money('deliveryFee', 'Entrega'), money('couvertFee', 'Couvert'), money('total', 'Total')],
    rows: list.map(o => ({ number: o.number, code: o.code, createdAt: o.createdAt, channel: CHANNEL_LABEL[o.channel] ?? o.channel, status: STATUS_LABEL[o.status] ?? o.status, customer: o.customerName ?? '', subtotal: o.subtotal, discount: o.discount, serviceFee: o.serviceFee, deliveryFee: o.deliveryFee, couvertFee: o.couvertFee, total: o.total })),
    totals: { code: `${list.length} pedidos`, ...totals }, truncated,
  };
}

async function serviceFee(ctx: Ctx): Promise<ReportBody> {
  const orders = await prisma.order.findMany({ where: { ...salesWhere(ctx), serviceFee: { gt: 0 } }, select: { createdAt: true, subtotal: true, discount: true, serviceFee: true }, take: ITEM_LIMIT });
  const byDay = new Map<string, typeof orders>();
  for (const order of orders) {
    const key = dayKey(order.createdAt, ctx.tz);
    byDay.set(key, [...(byDay.get(key) ?? []), order]);
  }
  const rows = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, group]) => {
    const base = sumDecimals(group.map(o => D(o.subtotal).sub(o.discount)));
    const fee = sumDecimals(group.map(o => o.serviceFee));
    return { day: formatDay(day), orders: group.length, base, fee, percent: percentOf(fee, base) };
  });
  const base = sumDecimals(rows.map(r => r.base)); const fee = sumDecimals(rows.map(r => r.fee));
  return {
    columns: [text('day', 'Dia'), num('orders', 'Pedidos'), money('base', 'Base de cálculo'), money('fee', 'Taxa de serviço'), pct('percent', '% sobre a base')],
    rows, totals: { day: 'Total', orders: orders.length, base, fee, percent: percentOf(fee, base) },
  };
}

async function couvert(ctx: Ctx): Promise<ReportBody> {
  const [orders, events] = await Promise.all([
    prisma.order.findMany({ where: { ...salesWhere(ctx), couvertFee: { gt: 0 } }, select: { createdAt: true, couvertFee: true }, take: ITEM_LIMIT }),
    prisma.coverEvent.findMany({ where: { tenantId: ctx.tenantId, startsAt: { lte: ctx.to }, endsAt: { gte: ctx.from } }, select: { description: true, amount: true, startsAt: true, endsAt: true } }),
  ]);
  const groups = new Map<string, { day: string; event: string; orders: number; amount: Prisma.Decimal }>();
  for (const order of orders) {
    const day = dayKey(order.createdAt, ctx.tz);
    const event = events.find(e => e.startsAt <= order.createdAt && e.endsAt >= order.createdAt)?.description ?? 'Sem evento';
    const key = `${day}|${event}`;
    const entry = groups.get(key) ?? { day, event, orders: 0, amount: D(0) };
    entry.orders += 1; entry.amount = entry.amount.add(order.couvertFee);
    groups.set(key, entry);
  }
  const rows = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.event.localeCompare(b.event)).map(g => ({ ...g, day: formatDay(g.day) }));
  return {
    columns: [text('day', 'Dia'), text('event', 'Evento'), num('orders', 'Pedidos'), money('amount', 'Couvert artístico')],
    rows, totals: { day: 'Total', orders: orders.length, amount: sumDecimals(rows.map(r => r.amount)) },
  };
}

async function dre(ctx: Ctx): Promise<ReportBody> {
  const [orderSums, items, expenses] = await Promise.all([
    prisma.order.aggregate({ where: salesWhere(ctx), _sum: { subtotal: true, discount: true, serviceFee: true, deliveryFee: true, couvertFee: true, total: true } }),
    loadItems(ctx),
    prisma.financialEntry.aggregate({ where: { ...ctx.scope, type: 'EXPENSE', status: 'PAID', settledAt: { gte: ctx.from, lte: ctx.to } }, _sum: { amount: true } }),
  ]);
  const gross = D(orderSums._sum.subtotal);
  const discount = D(orderSums._sum.discount);
  const fee = D(orderSums._sum.serviceFee);
  const delivery = D(orderSums._sum.deliveryFee);
  const cover = D(orderSums._sum.couvertFee);
  const net = D(orderSums._sum.total);
  // Combo wrappers are billing-only; their components carry the real cost.
  const cost = sumDecimals(items.filter(i => !i.product.isCombo).map(i => D(i.product.cost).mul(unitsOf(i)))).toDecimalPlaces(2);
  const grossProfit = net.sub(cost);
  const paidExpenses = D(expenses._sum.amount);
  const result = grossProfit.sub(paidExpenses);
  const line = (label: string, amount: Prisma.Decimal) => ({ line: label, amount, percent: percentOf(amount, gross) });
  return {
    columns: [text('line', 'Descrição'), money('amount', 'Valor'), pct('percent', '% da receita bruta')],
    rows: [
      line('Receita bruta (vendas)', gross), line('(−) Descontos', discount.negated()), line('(+) Taxa de serviço', fee), line('(+) Couvert artístico', cover), line('(+) Taxa de entrega', delivery),
      line('(=) Receita líquida', net), line('(−) Custo estimado dos produtos', cost.negated()), line('(=) Lucro bruto', grossProfit), line('(−) Despesas pagas', paidExpenses.negated()), line('(=) Resultado', result),
    ],
    totals: { line: 'Resultado do período', amount: result, percent: percentOf(result, gross) },
  };
}

async function cancellations(ctx: Ctx): Promise<ReportBody> {
  const orders = await prisma.order.findMany({
    where: { ...ctx.scope, status: 'CANCELLED', updatedAt: { gte: ctx.from, lte: ctx.to } }, orderBy: { updatedAt: 'asc' }, take: ROW_LIMIT,
    select: { id: true, number: true, code: true, channel: true, customerName: true, total: true, createdAt: true, updatedAt: true, createdByUserId: true },
  });
  const ids = orders.map(o => o.id);
  const [audits, releases] = ids.length === 0 ? [[], []] : await Promise.all([
    prisma.auditLog.findMany({ where: { tenantId: ctx.tenantId, action: 'ORDER_STATUS_CHANGED', entityId: { in: ids }, metadata: { path: ['status'], equals: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, select: { entityId: true, actorUserId: true } }),
    prisma.passwordRelease.findMany({ where: { tenantId: ctx.tenantId, action: 'CANCEL_ORDER', orderId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { orderId: true, reason: true } }),
  ]);
  const actorByOrder = new Map<string, string | null>();
  for (const audit of audits) if (audit.entityId && !actorByOrder.has(audit.entityId)) actorByOrder.set(audit.entityId, audit.actorUserId);
  const reasonByOrder = new Map<string, string | null>();
  for (const release of releases) if (release.orderId && !reasonByOrder.has(release.orderId)) reasonByOrder.set(release.orderId, release.reason);
  const userIds = [...new Set(orders.flatMap(o => { const actor = actorByOrder.get(o.id) ?? o.createdByUserId; return actor ? [actor] : []; }))];
  const users = userIds.length ? await prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map(u => [u.id, u.name]));
  const detailed = orders.map(o => {
    const actor = actorByOrder.get(o.id) ?? o.createdByUserId;
    return { number: o.number, code: o.code, createdAt: o.createdAt, cancelledAt: o.updatedAt, day: formatDay(dayKey(o.updatedAt, ctx.tz)), channel: CHANNEL_LABEL[o.channel] ?? o.channel, customer: o.customerName ?? '', user: actor ? names.get(actor) ?? 'Usuário removido' : 'Sem usuário', reason: reasonByOrder.get(o.id) ?? '', total: o.total };
  });
  const totalValue = sumDecimals(detailed.map(r => r.total));
  const groupBy = ctx.query.groupBy;
  if (groupBy === 'day' || groupBy === 'user') {
    const groups = new Map<string, { label: string; count: number; total: Prisma.Decimal }>();
    for (const row of detailed) {
      const label = groupBy === 'day' ? row.day : row.user;
      const entry = groups.get(label) ?? { label, count: 0, total: D(0) };
      entry.count += 1; entry.total = entry.total.add(row.total);
      groups.set(label, entry);
    }
    return { columns: [text('label', groupBy === 'day' ? 'Dia' : 'Usuário'), num('count', 'Cancelamentos'), money('total', 'Valor cancelado')], rows: [...groups.values()], totals: { label: 'Total', count: detailed.length, total: totalValue } };
  }
  return {
    columns: [num('number', 'Nº'), text('code', 'Código'), when('createdAt', 'Criado em'), when('cancelledAt', 'Cancelado em'), text('channel', 'Canal'), text('customer', 'Cliente'), text('user', 'Usuário'), text('reason', 'Motivo'), money('total', 'Valor')],
    rows: detailed.map(({ day: _day, ...row }) => row), totals: { code: `${detailed.length} pedidos`, total: totalValue },
  };
}

type Aggregated = { productId: string; name: string; category: string; quantity: Prisma.Decimal; revenue: Prisma.Decimal; weight: Prisma.Decimal; price: Prisma.Decimal; cost: Prisma.Decimal | null };
async function aggregateProducts(ctx: Ctx): Promise<Aggregated[]> {
  const items = (await loadItems(ctx)).filter(item => !item.parentItemId);
  const map = new Map<string, Aggregated>();
  for (const item of items) {
    const entry = map.get(item.productId) ?? { productId: item.productId, name: item.product.name, category: item.product.category?.name ?? 'Sem categoria', quantity: D(0), revenue: D(0), weight: D(0), price: item.product.price, cost: item.product.cost };
    entry.quantity = entry.quantity.add(item.quantity); entry.revenue = entry.revenue.add(item.total);
    if (item.weightKg) entry.weight = entry.weight.add(item.weightKg.mul(item.quantity));
    map.set(item.productId, entry);
  }
  return [...map.values()];
}

async function productClassification(ctx: Ctx): Promise<ReportBody> {
  const products = (await aggregateProducts(ctx)).sort((a, b) => b.revenue.comparedTo(a.revenue) || a.name.localeCompare(b.name));
  const total = sumDecimals(products.map(p => p.revenue));
  let before = D(0);
  const rows = products.map((product, index) => {
    const share = percentOf(product.revenue, total);
    const beforePercent = percentOf(before, total);
    before = before.add(product.revenue);
    // A product belongs to the class in which the cumulative share still stood below the limit when it entered.
    const abc = beforePercent < 80 ? 'A' : beforePercent < 95 ? 'B' : 'C';
    return { rank: index + 1, product: product.name, category: product.category, quantity: product.quantity.toNumber(), revenue: product.revenue, share, accumulated: percentOf(before, total), abc };
  });
  return {
    columns: [num('rank', '#'), text('product', 'Produto'), text('category', 'Categoria'), num('quantity', 'Quantidade'), money('revenue', 'Faturamento'), pct('share', '% do faturamento'), pct('accumulated', '% acumulado'), text('abc', 'Classe')],
    rows, totals: { product: `${rows.length} produtos`, quantity: sumDecimals(products.map(p => p.quantity)).toNumber(), revenue: total },
  };
}

async function scheduledSales(ctx: Ctx): Promise<ReportBody> {
  const orders = await prisma.order.findMany({
    where: { ...ctx.scope, scheduledFor: { gte: ctx.from, lte: ctx.to } }, orderBy: { scheduledFor: 'asc' }, take: ROW_LIMIT,
    select: { number: true, code: true, customerName: true, channel: true, status: true, scheduledFor: true, releaseAt: true, releasedAt: true, total: true },
  });
  const situation = (o: (typeof orders)[number]) => o.status === 'CANCELLED' ? 'Cancelado' : o.status === 'COMPLETED' ? 'Finalizado' : o.releasedAt ? 'Liberado' : 'Aguardando liberação';
  return {
    columns: [num('number', 'Nº'), text('code', 'Código'), text('customer', 'Cliente'), text('channel', 'Canal'), when('scheduledFor', 'Agendado para'), when('releaseAt', 'Liberação prevista'), when('releasedAt', 'Liberado em'), text('status', 'Situação'), money('total', 'Total')],
    rows: orders.map(o => ({ number: o.number, code: o.code, customer: o.customerName ?? '', channel: CHANNEL_LABEL[o.channel] ?? o.channel, scheduledFor: o.scheduledFor, releaseAt: o.releaseAt, releasedAt: o.releasedAt, status: situation(o), total: o.total })),
    totals: { code: `${orders.length} pedidos`, total: sumDecimals(orders.filter(o => o.status !== 'CANCELLED').map(o => o.total)) },
  };
}

async function productsSold(ctx: Ctx): Promise<ReportBody> {
  const products = (await aggregateProducts(ctx)).sort((a, b) => b.quantity.comparedTo(a.quantity) || a.name.localeCompare(b.name));
  return {
    columns: [text('product', 'Produto'), text('category', 'Categoria'), num('quantity', 'Quantidade'), num('weight', 'Peso (kg)'), money('revenue', 'Faturamento'), money('average', 'Preço médio')],
    rows: products.map(p => ({ product: p.name, category: p.category, quantity: p.quantity.toNumber(), weight: p.weight.isZero() ? null : p.weight.toNumber(), revenue: p.revenue, average: p.quantity.isZero() ? D(0) : p.revenue.div(p.quantity).toDecimalPlaces(2) })),
    totals: { product: `${products.length} produtos`, quantity: sumDecimals(products.map(p => p.quantity)).toNumber(), revenue: sumDecimals(products.map(p => p.revenue)) },
  };
}

async function profitMargin(ctx: Ctx): Promise<ReportBody> {
  const products = await aggregateProducts(ctx);
  const rows = products.map(p => {
    const units = p.weight.isZero() ? p.quantity : p.weight;
    const totalCost = p.cost ? p.cost.mul(units).toDecimalPlaces(2) : null;
    return {
      product: p.name, price: p.price, cost: p.cost, margin: p.cost && !p.price.isZero() ? percentOf(p.price.sub(p.cost), p.price) : null, quantity: p.quantity.toNumber(),
      revenue: p.revenue, totalCost, profit: totalCost ? p.revenue.sub(totalCost) : null,
    };
  }).sort((a, b) => (b.profit ? b.profit.toNumber() : -Infinity) - (a.profit ? a.profit.toNumber() : -Infinity));
  const costed = rows.filter(r => r.totalCost && r.profit);
  const revenue = sumDecimals(costed.map(r => r.revenue)); const profit = sumDecimals(costed.map(r => r.profit));
  return {
    columns: [text('product', 'Produto'), money('price', 'Preço de venda'), money('cost', 'Custo'), pct('margin', 'Margem %'), num('quantity', 'Qtd. vendida'), money('revenue', 'Faturamento'), money('totalCost', 'Custo estimado'), money('profit', 'Lucro estimado')],
    rows, totals: { product: 'Produtos com custo cadastrado', revenue, totalCost: sumDecimals(costed.map(r => r.totalCost)), profit, margin: percentOf(profit, revenue) },
  };
}

async function salesByPayment(ctx: Ctx): Promise<ReportBody> {
  const [groups, configs] = await Promise.all([
    prisma.payment.groupBy({ by: ['method'], where: { ...ctx.scope, status: 'CONFIRMED', paidAt: { gte: ctx.from, lte: ctx.to } }, _sum: { amount: true }, _count: true }),
    prisma.paymentMethodConfig.findMany({ where: { tenantId: ctx.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true, equivalent: true } }),
  ]);
  // A payment only stores its equivalent method, so the configured name is used when it is unambiguous.
  const nameFor = (method: string) => {
    const matches = configs.filter(c => c.equivalent === method);
    return matches.length === 1 ? matches[0].name : METHOD_LABEL[method] ?? method;
  };
  const total = sumDecimals(groups.map(g => g._sum.amount));
  const rows = groups.map(g => ({ method: nameFor(g.method), kind: METHOD_LABEL[g.method] ?? g.method, count: g._count, amount: D(g._sum.amount), share: percentOf(D(g._sum.amount), total) })).sort((a, b) => b.amount.comparedTo(a.amount));
  return {
    columns: [text('method', 'Forma de pagamento'), text('kind', 'Tipo'), num('count', 'Pagamentos'), money('amount', 'Valor'), pct('share', '% do total')],
    rows, totals: { method: 'Total recebido', count: groups.reduce((sum, g) => sum + g._count, 0), amount: total },
  };
}

async function financialEntries(ctx: Ctx, type: 'EXPENSE' | 'INCOME'): Promise<ReportBody> {
  const status = z.enum(['OPEN', 'PAID', 'CANCELLED']).safeParse(ctx.query.status);
  const inPeriod = { gte: ctx.from, lte: ctx.to };
  const entries = await prisma.financialEntry.findMany({
    where: { ...ctx.scope, type, ...(status.success ? { status: status.data } : { status: { not: 'CANCELLED' } }), OR: [{ dueAt: inPeriod }, { dueAt: null, createdAt: inPeriod }] },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }], take: ROW_LIMIT,
  });
  const label: Record<string, string> = { OPEN: 'Em aberto', PAID: type === 'EXPENSE' ? 'Pago' : 'Recebido', CANCELLED: 'Cancelado' };
  const rows = entries.map(e => {
    const late = e.status === 'OPEN' && e.dueAt !== null && e.dueAt < ctx.now;
    return { description: e.description, category: e.category ?? '', dueAt: e.dueAt, status: late ? 'Em atraso' : label[e.status], daysLate: late ? Math.max(1, Math.floor((ctx.now.getTime() - e.dueAt!.getTime()) / DAY_MS)) : 0, amount: e.amount, settledAt: e.settledAt };
  });
  const sumWhere = (pick: (row: (typeof rows)[number]) => boolean) => sumDecimals(rows.filter(pick).map(r => r.amount));
  return {
    columns: [text('description', 'Descrição'), text('category', 'Categoria'), when('dueAt', 'Vencimento'), text('status', 'Situação'), num('daysLate', 'Dias em atraso'), money('amount', 'Valor'), when('settledAt', type === 'EXPENSE' ? 'Pago em' : 'Recebido em')],
    rows,
    totals: { description: `${rows.length} lançamentos`, amount: sumWhere(r => r.status !== 'Cancelado'), open: sumWhere(r => r.status === 'Em aberto'), late: sumWhere(r => r.status === 'Em atraso'), settled: sumWhere(r => r.status === 'Pago' || r.status === 'Recebido') },
  };
}

async function cashClosings(ctx: Ctx): Promise<ReportBody> {
  const sessions = await prisma.cashSession.findMany({ where: { ...ctx.scope, openedAt: { gte: ctx.from, lte: ctx.to } }, orderBy: { openedAt: 'asc' }, take: ROW_LIMIT });
  const userIds = [...new Set(sessions.flatMap(s => [s.openedByUserId, ...(s.closedByUserId ? [s.closedByUserId] : [])]))];
  const users = userIds.length ? await prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map(u => [u.id, u.name]));
  const rows = sessions.map(s => {
    const closed = s.status === 'CLOSED' && s.closingAmount !== null && s.expectedAmount !== null;
    return {
      openedAt: s.openedAt, closedAt: s.closedAt, operator: names.get(s.closedByUserId ?? s.openedByUserId) ?? 'Usuário removido', status: s.status === 'OPEN' ? 'Aberto' : 'Fechado',
      opening: s.openingAmount, expected: s.expectedAmount, counted: s.closingAmount, difference: closed ? s.closingAmount!.sub(s.expectedAmount!) : null,
    };
  });
  const closedRows = rows.filter(r => r.difference !== null);
  return {
    columns: [when('openedAt', 'Abertura'), when('closedAt', 'Fechamento'), text('operator', 'Operador'), text('status', 'Situação'), money('opening', 'Abertura (troco)'), money('expected', 'Esperado'), money('counted', 'Contado'), money('difference', 'Diferença')],
    rows, totals: { operator: `${rows.length} caixas`, expected: sumDecimals(closedRows.map(r => r.expected)), counted: sumDecimals(closedRows.map(r => r.counted)), difference: sumDecimals(closedRows.map(r => r.difference)) },
  };
}

async function deliveryZones(ctx: Ctx): Promise<ReportBody> {
  const [groups, zones] = await Promise.all([
    prisma.order.groupBy({ by: ['deliveryZoneId'], where: { ...salesWhere(ctx), OR: [{ deliveryZoneId: { not: null } }, { channel: 'DELIVERY' }] }, _count: true, _sum: { subtotal: true, deliveryFee: true, total: true } }),
    prisma.deliveryZone.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true } }),
  ]);
  const names = new Map(zones.map(z => [z.id, z.name]));
  const rows = groups.map(g => ({ zone: g.deliveryZoneId ? names.get(g.deliveryZoneId) ?? 'Zona removida' : 'Sem zona', orders: g._count, subtotal: D(g._sum.subtotal), deliveryFee: D(g._sum.deliveryFee), total: D(g._sum.total), average: g._count ? D(g._sum.total).div(g._count).toDecimalPlaces(2) : D(0) })).sort((a, b) => b.orders - a.orders);
  const orders = rows.reduce((sum, r) => sum + r.orders, 0); const total = sumDecimals(rows.map(r => r.total));
  return {
    columns: [text('zone', 'Zona de entrega'), num('orders', 'Pedidos'), money('subtotal', 'Produtos'), money('deliveryFee', 'Taxas de entrega'), money('total', 'Total'), money('average', 'Ticket médio')],
    rows, totals: { zone: 'Total', orders, subtotal: sumDecimals(rows.map(r => r.subtotal)), deliveryFee: sumDecimals(rows.map(r => r.deliveryFee)), total, average: orders ? total.div(orders).toDecimalPlaces(2) : D(0) },
  };
}

async function loyalCustomers(ctx: Ctx): Promise<ReportBody> {
  const groups = await prisma.order.groupBy({
    by: ['customerId'], where: { ...salesWhere(ctx), customerId: { not: null } }, _count: true, _sum: { total: true }, _max: { createdAt: true },
    orderBy: [{ _count: { customerId: 'desc' } }, { _sum: { total: 'desc' } }], take: 200,
  });
  const customers = await prisma.customer.findMany({ where: { tenantId: ctx.tenantId, id: { in: groups.flatMap(g => g.customerId ? [g.customerId] : []) } }, select: { id: true, name: true, phone: true, loyaltyPoints: true } });
  const byId = new Map(customers.map(c => [c.id, c]));
  const rows = groups.flatMap(g => {
    const customer = g.customerId ? byId.get(g.customerId) : undefined;
    return customer ? [{ customer: customer.name, phone: customer.phone, orders: g._count, total: D(g._sum.total), average: D(g._sum.total).div(g._count).toDecimalPlaces(2), lastOrderAt: g._max.createdAt, points: customer.loyaltyPoints }] : [];
  });
  return {
    columns: [text('customer', 'Cliente'), text('phone', 'Telefone'), num('orders', 'Pedidos'), money('total', 'Total gasto'), money('average', 'Ticket médio'), when('lastOrderAt', 'Último pedido'), num('points', 'Pontos')],
    rows, totals: { customer: `${rows.length} clientes`, orders: rows.reduce((sum, r) => sum + r.orders, 0), total: sumDecimals(rows.map(r => r.total)) },
  };
}

async function promotedProducts(ctx: Ctx): Promise<ReportBody> {
  const promotions = await prisma.promotion.findMany({
    where: { tenantId: ctx.tenantId, startsAt: { lte: ctx.to }, OR: [{ endsAt: null }, { endsAt: { gte: ctx.from } }] }, orderBy: { startsAt: 'desc' }, take: 200,
    include: { products: { include: { product: { select: { id: true, name: true, price: true } } } } },
  });
  const productIds = new Set(promotions.flatMap(p => p.products.map(link => link.productId)));
  const items = productIds.size === 0 ? [] : (await loadItems(ctx)).filter(item => !item.parentItemId && productIds.has(item.productId));
  const rows = promotions.flatMap(promotion => promotion.products.map(({ product }) => {
    const sold = items.filter(item => item.productId === product.id && item.unitPrice.lt(item.product.price) && item.order.createdAt >= promotion.startsAt && (!promotion.endsAt || item.order.createdAt <= promotion.endsAt));
    const status = !promotion.active ? 'Inativa' : promotion.startsAt > ctx.now ? 'Agendada' : promotion.endsAt && promotion.endsAt < ctx.now ? 'Encerrada' : 'Vigente';
    const promoPrice = effectiveUnitPrice(product.id, product.price, [{ type: promotion.type, value: promotion.value, startsAt: new Date(0), endsAt: null, active: true, productIds: [product.id] }]);
    return {
      promotion: promotion.name, product: product.name, discount: promotion.type === 'PERCENT' ? `${promotion.value.toString()}%` : `R$ ${promotion.value.toFixed(2).replace('.', ',')}`, startsAt: promotion.startsAt, endsAt: promotion.endsAt, status,
      price: product.price, promoPrice, quantity: sold.reduce((sum, item) => sum + item.quantity, 0), revenue: sumDecimals(sold.map(item => item.total)),
    };
  }));
  return {
    columns: [text('promotion', 'Promoção'), text('product', 'Produto'), text('discount', 'Desconto'), when('startsAt', 'Início'), when('endsAt', 'Fim'), text('status', 'Situação'), money('price', 'Preço normal'), money('promoPrice', 'Preço promocional'), num('quantity', 'Qtd. vendida em promoção'), money('revenue', 'Faturamento em promoção')],
    rows, totals: { promotion: `${rows.length} produtos`, quantity: rows.reduce((sum, r) => sum + r.quantity, 0), revenue: sumDecimals(rows.map(r => r.revenue)) },
  };
}

async function availability(ctx: Ctx): Promise<ReportBody> {
  const filter = ctx.query.status;
  const products = await prisma.product.findMany({
    where: { tenantId: ctx.tenantId, ...(ctx.scope.unitId ? { OR: [{ unitId: ctx.scope.unitId }, { unitId: null }] } : {}), ...(filter === 'active' ? { active: true } : filter === 'inactive' ? { active: false } : {}) },
    orderBy: { name: 'asc' }, take: ROW_LIMIT,
    include: { category: { select: { name: true } }, recipe: { include: { ingredients: { include: { ingredient: { select: { name: true, currentStock: true, minimumStock: true, active: true } } } } } } },
  });
  const rows = products.map(product => {
    const lines = product.recipe && product.recipe.yield.gt(0) ? product.recipe.ingredients.filter(line => line.quantity.gt(0)) : [];
    let stock = 'Sem controle de estoque'; let portions: number | null = null; let limiting = '';
    if (!product.isCombo && lines.length > 0) {
      let min: Prisma.Decimal | null = null; let low = false;
      for (const line of lines) {
        const possible = line.ingredient.active ? line.ingredient.currentStock.div(line.quantity.div(product.recipe!.yield)).floor() : D(0);
        if (min === null || possible.lt(min)) { min = possible; limiting = line.ingredient.name; }
        if (line.ingredient.minimumStock && line.ingredient.currentStock.lte(line.ingredient.minimumStock)) low = true;
      }
      portions = min!.toNumber();
      stock = portions <= 0 ? 'Sem estoque' : low ? 'Estoque baixo' : 'Disponível';
    }
    return { product: product.name, category: product.category?.name ?? 'Sem categoria', status: product.active ? 'Ativo' : 'Inativo', stock, portions, limiting: portions === null ? '' : limiting };
  });
  const active = rows.filter(r => r.status === 'Ativo').length;
  return {
    columns: [text('product', 'Produto'), text('category', 'Categoria'), text('status', 'Cadastro'), text('stock', 'Estoque'), num('portions', 'Porções possíveis'), text('limiting', 'Ingrediente limitante')],
    rows, totals: { product: `${rows.length} produtos`, status: `${active} ativos / ${rows.length - active} inativos`, stock: `${rows.filter(r => r.stock === 'Sem estoque').length} sem estoque` },
  };
}

async function botConversations(ctx: Ctx): Promise<ReportBody> {
  const messages = await prisma.whatsappMessage.findMany({
    where: { tenantId: ctx.tenantId, createdAt: { gte: ctx.from, lte: ctx.to }, ...(ctx.scope.unitId ? { order: { unitId: ctx.scope.unitId } } : {}) },
    select: { createdAt: true, status: true }, take: ITEM_LIMIT,
  });
  const byDay = new Map<string, { total: number; sent: number; failed: number; queued: number }>();
  for (const message of messages) {
    const key = dayKey(message.createdAt, ctx.tz);
    const entry = byDay.get(key) ?? { total: 0, sent: 0, failed: 0, queued: 0 };
    entry.total += 1;
    if (message.status === 'SENT') entry.sent += 1; else if (message.status === 'FAILED') entry.failed += 1; else entry.queued += 1;
    byDay.set(key, entry);
  }
  const rows = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, e]) => ({ day: formatDay(day), ...e, rate: percentOf(e.sent, e.total) }));
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    columns: [text('day', 'Dia'), num('total', 'Atendimentos'), num('sent', 'Enviados'), num('failed', 'Falhas'), num('queued', 'Na fila'), pct('rate', '% enviados ao provedor')],
    rows, totals: { day: 'Total', total: sum(r => r.total), sent: sum(r => r.sent), failed: sum(r => r.failed), queued: sum(r => r.queued), rate: percentOf(sum(r => r.sent), sum(r => r.total)) },
  };
}

type ReportDefinition = { title: string; description: string; group: string; build: (ctx: Ctx) => Promise<ReportBody> };
const REPORTS: Record<string, ReportDefinition> = {
  sales: { title: 'Vendas', description: 'Pedidos do período por pedido ou por dia (groupBy=day).', group: 'Vendas', build: sales },
  'service-fee': { title: 'Taxa de serviço', description: 'Taxa de serviço cobrada por dia sobre a base de cálculo.', group: 'Vendas', build: serviceFee },
  couvert: { title: 'Couvert artístico', description: 'Couvert cobrado por dia e evento.', group: 'Vendas', build: couvert },
  dre: { title: 'DRE simplificado', description: 'Receita, descontos, custo estimado, despesas pagas e resultado.', group: 'Resultado financeiro', build: dre },
  cancellations: { title: 'Análise de cancelamentos', description: 'Pedidos cancelados, usuário e motivo quando informado (groupBy=day|user).', group: 'Vendas', build: cancellations },
  'product-classification': { title: 'Classificação de produtos', description: 'Curva ABC por faturamento (A até 80%, B até 95%, C o restante).', group: 'Produtos', build: productClassification },
  'scheduled-sales': { title: 'Vendas agendadas', description: 'Pedidos agendados, liberação e situação.', group: 'Vendas', build: scheduledSales },
  'products-sold': { title: 'Produtos vendidos', description: 'Quantidade e faturamento por produto.', group: 'Produtos', build: productsSold },
  'profit-margin': { title: 'Margem de lucro dos produtos', description: 'Preço, custo e margem dos produtos vendidos.', group: 'Produtos', build: profitMargin },
  'sales-by-payment': { title: 'Vendas por formas de pagamento', description: 'Pagamentos confirmados por forma de pagamento.', group: 'Resultado financeiro', build: salesByPayment },
  payables: { title: 'Contas a pagar', description: 'Despesas por vencimento e situação, com atraso.', group: 'Resultado financeiro', build: ctx => financialEntries(ctx, 'EXPENSE') },
  receivables: { title: 'Contas a receber', description: 'Receitas por vencimento e situação, com atraso.', group: 'Resultado financeiro', build: ctx => financialEntries(ctx, 'INCOME') },
  'cash-closings': { title: 'Conferência de fechamentos', description: 'Caixa esperado, contado e diferença por fechamento.', group: 'Resultado financeiro', build: cashClosings },
  'delivery-zones': { title: 'Zonas de entrega', description: 'Pedidos e valores por zona de entrega.', group: 'Entrega', build: deliveryZones },
  'loyal-customers': { title: 'Clientes fiéis', description: 'Clientes por número de pedidos, total gasto e pontos.', group: 'Clientes', build: loyalCustomers },
  'promoted-products': { title: 'Produtos em promoção', description: 'Promoções vigentes e históricas e vendas com preço promocional.', group: 'Produtos', build: promotedProducts },
  availability: { title: 'Controle de disponibilidade', description: 'Produtos ativos, inativos e sem estoque conforme a ficha técnica.', group: 'Produtos', build: availability },
  'bot-conversations': { title: 'Atendimentos via robô', description: 'Mensagens de WhatsApp por dia e situação.', group: 'Clientes', build: botConversations },
};

reportsExtraRoutes.get('/x', (_req, res) => {
  res.json({ items: Object.entries(REPORTS).map(([kind, { title, description, group }]) => ({ kind, title, description, group })) });
});

reportsExtraRoutes.get('/x/:kind', async (req, res, next) => {
  try {
    const definition = Object.hasOwn(REPORTS, req.params.kind) ? REPORTS[req.params.kind] : undefined;
    if (!definition) return res.status(404).json({ message: 'Report not found' });
    const period = parsePeriod(req.query);
    if (!period) return res.status(400).json({ message: 'Invalid date range' });
    const scope = tenantScope(req) as Ctx['scope'];
    const tz = (await loadSettings(prisma, scope.tenantId)).hours.timezone;
    const body = await definition.build({ tenantId: scope.tenantId, scope, ...period, tz, now: new Date(), query: req.query });
    const report = finalizeReport(req.params.kind, period, body);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${req.params.kind}.csv"`);
      return res.send(reportToCsv(report, tz));
    }
    return res.json(report);
  } catch (error) { return next(error); }
});
