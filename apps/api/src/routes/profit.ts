import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, type TenantSettingsData } from '../lib/settings';
import { requireAuth, requireTenant } from '../middleware/auth';
import { tenantScope } from '../lib/report-helpers';
import { computeProfit, groupItems, suggestPrice, type ProfitItem } from '../lib/profit';

export const profitRoutes = Router();
profitRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

const n = (value: Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const r2 = (value: number) => Math.round(value * 100) / 100;
const ITEM_CAP = 100_000;

function period(query: Record<string, unknown>): { from: Date; to: Date } | null {
  const now = new Date();
  const from = typeof query.from === 'string' ? new Date(query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = typeof query.to === 'string' ? new Date(query.to) : now;
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to ? null : { from, to };
}

type Scope = ReturnType<typeof tenantScope>;

// Cost per portion of a recipe from the registered average cost of each ingredient; null when any ingredient has no cost yet.
async function recipeCosts(tenantId: string, productIds?: string[]) {
  const recipes = await prisma.recipe.findMany({
    where: { tenantId, ...(productIds ? { productId: { in: productIds } } : {}) },
    select: { productId: true, yield: true, ingredients: { select: { quantity: true, ingredient: { select: { name: true, unitOfMeasure: true, averageCost: true } } } } },
  });
  return new Map(recipes.map(recipe => {
    const yieldQty = n(recipe.yield) > 0 ? n(recipe.yield) : 1;
    const complete = recipe.ingredients.length > 0 && recipe.ingredients.every(line => n(line.ingredient.averageCost) > 0);
    const total = recipe.ingredients.reduce((sum, line) => sum + n(line.quantity) * n(line.ingredient.averageCost), 0);
    return [recipe.productId, { perPortion: complete ? r2(total / yieldQty) : null, complete, lines: recipe.ingredients.map(line => ({ name: line.ingredient.name, unit: line.ingredient.unitOfMeasure, quantity: n(line.quantity), unitCost: n(line.ingredient.averageCost), total: r2(n(line.quantity) * n(line.ingredient.averageCost)) })) }] as const;
  }));
}

async function analyze(scope: Scope, settings: TenantSettingsData, from: Date, to: Date) {
  const completed = { ...scope, status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } };
  const [sums, cancelled, payments, items, expenses, byUnit, units] = await Promise.all([
    prisma.order.aggregate({ where: completed, _sum: { total: true, discount: true, serviceFee: true, deliveryFee: true } }),
    prisma.order.aggregate({ where: { ...scope, status: OrderStatus.CANCELLED, createdAt: { gte: from, lte: to } }, _sum: { total: true }, _count: true }),
    prisma.payment.groupBy({ by: ['method'], where: { ...scope, status: 'CONFIRMED', paidAt: { gte: from, lte: to } }, _sum: { amount: true } }),
    prisma.orderItem.findMany({
      where: { order: completed }, take: ITEM_CAP,
      select: { productId: true, quantity: true, weightKg: true, total: true, unitCost: true, order: { select: { createdByUserId: true } }, product: { select: { cost: true, isCombo: true, name: true, category: { select: { name: true } } } } },
    }),
    prisma.financialEntry.findMany({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: from, lte: to } }, select: { category: true, paidAmount: true, amount: true } }),
    prisma.order.groupBy({ by: ['unitId'], where: completed, _sum: { serviceFee: true } }),
    prisma.unit.findMany({ where: { tenantId: scope.tenantId }, select: { id: true, waiterSharePercent: true } }),
  ]);
  const recipes = await recipeCosts(scope.tenantId, [...new Set(items.filter(item => item.unitCost === null && item.product.cost === null && !item.product.isCombo).map(item => item.productId))]);
  const profitItems: (ProfitItem & { productName: string })[] = items.map(item => {
    const units = item.weightKg ? n(item.weightKg) * n(item.quantity) : n(item.quantity);
    // The cost frozen at sale time wins; older sales fall back to the current cost or recipe.
    const unitCost = item.product.isCombo ? 0 : item.unitCost !== null ? n(item.unitCost) : item.product.cost !== null ? n(item.product.cost) : recipes.get(item.productId)?.perPortion ?? null;
    return { productId: item.productId, productName: item.product.name, category: item.product.category?.name ?? 'Sem categoria', userId: item.order.createdByUserId, units, revenue: n(item.total), unitCost };
  });
  const expenseMap = new Map<string, number>();
  for (const entry of expenses) { const key = entry.category ?? 'Sem categoria'; expenseMap.set(key, (expenseMap.get(key) ?? 0) + (n(entry.paidAmount) || n(entry.amount))); }
  const share = new Map(units.map(unit => [unit.id, n(unit.waiterSharePercent)]));
  const commissions = byUnit.reduce((sum, row) => sum + n(row._sum.serviceFee) * (row.unitId ? share.get(row.unitId) ?? 100 : 100) / 100, 0);
  const sumMethod = (methods: string[]) => payments.filter(row => methods.includes(row.method)).reduce((sum, row) => sum + n(row._sum.amount), 0);
  const result = computeProfit({
    netRevenue: n(sums._sum.total), discounts: n(sums._sum.discount), cancelledCount: cancelled._count, cancelledValue: n(cancelled._sum.total),
    serviceFees: n(sums._sum.serviceFee), deliveryFees: n(sums._sum.deliveryFee), received: payments.reduce((sum, row) => sum + n(row._sum.amount), 0), cardReceived: sumMethod(['CREDIT_CARD', 'DEBIT_CARD']),
    commissions, items: profitItems, expenses: [...expenseMap.entries()].map(([category, amount]) => ({ category, amount })), config: settings.profit,
  });
  return { result, items: profitItems, truncated: items.length >= ITEM_CAP };
}

profitRoutes.get('/summary', async (req, res, next) => {
  try {
    const range = period(req.query);
    if (!range) return res.status(400).json({ message: 'Invalid date range' });
    const scope = tenantScope(req);
    const settings = await loadSettings(prisma, scope.tenantId);
    const length = range.to.getTime() - range.from.getTime();
    const previousRange = { from: new Date(range.from.getTime() - length - 1), to: new Date(range.from.getTime() - 1) };
    const [current, previous] = await Promise.all([analyze(scope, settings, range.from, range.to), analyze(scope, settings, previousRange.from, previousRange.to)]);
    const userIds = [...new Set(current.items.map(item => item.userId).filter((id): id is string => Boolean(id)))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: scope.tenantId }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map(user => [user.id, user.name]));
    return res.json({
      period: range, previousPeriod: previousRange, truncated: current.truncated, config: settings.profit, result: current.result, previous: previous.result,
      byProduct: groupItems(current.items, item => ({ key: item.productId, name: (item as typeof item & { productName: string }).productName })).slice(0, 30),
      byCategory: groupItems(current.items, item => ({ key: item.category, name: item.category })),
      byEmployee: groupItems(current.items, item => ({ key: item.userId ?? 'none', name: item.userId ? userName.get(item.userId) ?? 'Usuário removido' : 'Sem responsável' })),
      notes: [
        'Faturamento é o valor vendido; recebimento é o valor efetivamente pago; lucro só existe depois dos custos.',
        'Custos de mercadoria usam o custo do produto ou a ficha técnica; itens sem custo ficam fora do lucro e aparecem na cobertura.',
        'Taxas de cartão e impostos são estimativas pelos percentuais configurados. Folha de pagamento entra pelas despesas pagas lançadas no financeiro.',
      ],
    });
  } catch (error) { return next(error); }
});

profitRoutes.get('/recipes', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const products = await prisma.product.findMany({ where: { tenantId, recipe: { isNot: null } }, select: { id: true, name: true, price: true, cost: true, packagingPrice: true, packagingEnabled: true, category: { select: { name: true } } }, orderBy: { name: 'asc' }, take: 500 });
    const costs = await recipeCosts(tenantId, products.map(product => product.id));
    return res.json({
      items: products.map(product => {
        const recipe = costs.get(product.id);
        const portion = recipe?.perPortion ?? null;
        const price = n(product.price);
        return { id: product.id, name: product.name, category: product.category?.name ?? 'Sem categoria', price, registeredCost: product.cost === null ? null : n(product.cost), recipeCost: portion, complete: recipe?.complete ?? false, lines: recipe?.lines ?? [], packagingCost: product.packagingEnabled ? n(product.packagingPrice) : 0, margin: portion === null ? null : r2(price - portion), marginPercent: portion !== null && price > 0 ? r2(((price - portion) / price) * 100) : null, divergent: portion !== null && product.cost !== null && Math.abs(portion - n(product.cost)) >= 0.01 };
      }),
    });
  } catch (error) { return next(error); }
});

profitRoutes.get('/simulate', (req, res) => {
  const query = z.object({ cost: z.coerce.number().min(0), margin: z.coerce.number().min(0).max(99.99) }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ message: 'Informe custo e margem desejada' });
  return res.json({ suggestedPrice: suggestPrice(query.data.cost, query.data.margin) });
});

profitRoutes.post('/recipes/:productId/apply-cost', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const product = await prisma.product.findFirst({ where: { id: req.params.productId, tenantId }, select: { id: true, name: true, cost: true } });
    if (!product) return res.status(404).json({ message: 'Produto não encontrado' });
    const recipe = (await recipeCosts(tenantId, [product.id])).get(product.id);
    if (!recipe || recipe.perPortion === null) return res.status(409).json({ message: 'A ficha técnica está incompleta: todos os ingredientes precisam ter custo médio registrado' });
    const updated = await prisma.$transaction(async tx => {
      const saved = await tx.product.update({ where: { id: product.id }, data: { cost: new Prisma.Decimal(recipe.perPortion!) } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'PRODUCT_COST_UPDATED', entityType: 'Product', entityId: product.id, metadata: { name: product.name, before: product.cost === null ? null : n(product.cost), after: recipe.perPortion, source: 'RECIPE' } } });
      return saved;
    });
    return res.json({ id: updated.id, cost: n(updated.cost) });
  } catch (error) { return next(error); }
});

profitRoutes.get('/cost-history', async (req, res, next) => {
  try {
    const items = await prisma.auditLog.findMany({ where: { tenantId: req.auth!.tenantId!, action: 'PRODUCT_COST_UPDATED' }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, entityId: true, metadata: true, createdAt: true, actor: { select: { name: true } } } });
    return res.json({ items });
  } catch (error) { return next(error); }
});

profitRoutes.get('/waste', async (req, res, next) => {
  try {
    const WASTE_CATEGORY = { EXPIRED: 'Vencido', DAMAGED: 'Danificado', PRODUCTION: 'Perda na produção', OTHER: 'Outros' } as const;
    const range = period(req.query);
    if (!range) return res.status(400).json({ message: 'Invalid date range' });
    const scope = tenantScope(req);
    const moves = await prisma.stockMovement.findMany({
      where: { ...scope, type: 'WASTE', createdAt: { gte: range.from, lte: range.to } }, orderBy: { createdAt: 'desc' }, take: 1000,
      select: { id: true, quantity: true, unitCost: true, note: true, reason: true, createdAt: true, actorUserId: true, ingredient: { select: { name: true, unitOfMeasure: true, averageCost: true } } },
    });
    const actorIds = [...new Set(moves.map(move => move.actorUserId).filter((id): id is string => Boolean(id)))];
    const users = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds }, tenantId: scope.tenantId }, select: { id: true, name: true } }) : [];
    const rows = moves.map(move => ({ id: move.id, createdAt: move.createdAt, ingredient: move.ingredient.name, unit: move.ingredient.unitOfMeasure, quantity: Math.abs(n(move.quantity)), category: WASTE_CATEGORY[move.reason ?? 'OTHER'], reason: move.note ?? 'Sem justificativa', responsible: users.find(user => user.id === move.actorUserId)?.name ?? '—', cost: r2(Math.abs(n(move.quantity)) * (n(move.unitCost) || n(move.ingredient.averageCost))) }));
    const group = (key: 'ingredient' | 'responsible' | 'reason' | 'category') => [...rows.reduce((map, row) => map.set(row[key], (map.get(row[key]) ?? 0) + row.cost), new Map<string, number>()).entries()].map(([name, cost]) => ({ name, cost: r2(cost) })).sort((a, b) => b.cost - a.cost);
    return res.json({ items: rows, total: r2(rows.reduce((sum, row) => sum + row.cost, 0)), byIngredient: group('ingredient'), byResponsible: group('responsible'), byReason: group('reason'), byCategory: group('category'), unvalued: rows.filter(row => row.cost === 0).length });
  } catch (error) { return next(error); }
});
