import { Router } from 'express';
import { OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';

// Network view (multi-unit): consolidated and per-unit indicators. Only people not bound to a single unit may see it, so a unit never reads
// another unit's numbers; each query stays inside the caller's tenant.
export const networkRoutes = Router();
networkRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES), (req, res, next) => (req.auth!.unitId ? res.status(403).json({ message: 'Visão da rede disponível apenas para quem não está vinculado a uma unidade' }) : next()));

const n = (value: Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

networkRoutes.get('/comparison', async (req, res, next) => {
  try {
    const query = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid date range' });
    const now = new Date();
    const from = query.data.from ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.data.to ?? now;
    if (from > to) return res.status(400).json({ message: 'Invalid date range' });
    const tenantId = req.auth!.tenantId!;
    const [units, sales, expenses, ingredients] = await Promise.all([
      prisma.unit.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.order.groupBy({ by: ['unitId'], where: { tenantId, status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } }, _sum: { total: true }, _count: { _all: true } }),
      prisma.financialEntry.groupBy({ by: ['unitId'], where: { tenantId, type: 'EXPENSE', status: 'PAID', settledAt: { gte: from, lte: to } }, _sum: { paidAmount: true } }),
      prisma.ingredient.findMany({ where: { tenantId, active: true, minimumStock: { not: null } }, select: { unitId: true, currentStock: true, minimumStock: true } }),
    ]);
    const rows = [...units.map(unit => ({ unitId: unit.id as string | null, name: unit.name })), { unitId: null, name: 'Sem unidade (matriz/geral)' }].map(unit => {
      const sold = sales.find(row => row.unitId === unit.unitId);
      const spent = n(expenses.find(row => row.unitId === unit.unitId)?._sum.paidAmount);
      const revenue = n(sold?._sum.total); const orders = sold?._count._all ?? 0;
      return { ...unit, revenue: round2(revenue), orders, avgTicket: orders > 0 ? round2(revenue / orders) : null, expenses: round2(spent), result: round2(revenue - spent), criticalStock: ingredients.filter(item => item.unitId === unit.unitId && n(item.currentStock) <= n(item.minimumStock)).length };
    }).filter(row => row.unitId !== null || row.orders > 0 || row.expenses > 0);
    const revenue = round2(rows.reduce((sum, row) => sum + row.revenue, 0)); const orders = rows.reduce((sum, row) => sum + row.orders, 0); const expensesTotal = round2(rows.reduce((sum, row) => sum + row.expenses, 0));
    return res.json({ period: { from, to }, totals: { revenue, orders, avgTicket: orders > 0 ? round2(revenue / orders) : null, expenses: expensesTotal, result: round2(revenue - expensesTotal) }, units: rows.map(row => ({ ...row, share: revenue > 0 ? round2((row.revenue / revenue) * 100) : 0 })), note: 'Pedidos concluídos e despesas pagas no período. Despesas sem unidade aparecem na linha "Sem unidade".' });
  } catch (error) { return next(error); }
});

