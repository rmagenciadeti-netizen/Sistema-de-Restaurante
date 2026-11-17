import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { prisma } from '../lib/prisma';

export const reportsRoutes = Router();
reportsRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
reportsRoutes.get('/overview', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const scope = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const [orders, orderTotals, paymentMethods, expenses, popularItems] = await Promise.all([
      prisma.order.count({ where: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } } }),
      prisma.order.aggregate({ where: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } }, _sum: { subtotal: true, serviceFee: true, deliveryFee: true, discount: true, total: true } }),
      prisma.payment.groupBy({ by: ['method'], where: { ...scope, paidAt: { gte: from, lte: to }, status: 'CONFIRMED' }, _sum: { amount: true }, _count: true }),
      prisma.financialEntry.aggregate({ where: { ...scope, type: 'EXPENSE', status: 'PAID', settledAt: { gte: from, lte: to } }, _sum: { amount: true } }),
      prisma.orderItem.groupBy({ by: ['productId'], where: { order: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } } }, _sum: { quantity: true, total: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 10 }),
    ]);
    const productIds = popularItems.map(x => x.productId); const products = await prisma.product.findMany({ where: { id: { in: productIds }, tenantId: req.auth!.tenantId! }, select: { id: true, name: true } }); const names = new Map(products.map(p => [p.id, p.name]));
    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, orders, totals: orderTotals._sum, paidExpenses: expenses._sum.amount ?? 0, paymentsByMethod: paymentMethods, bestSellers: popularItems.map(x => ({ productId: x.productId, name: names.get(x.productId) ?? 'Produto removido', quantity: x._sum.quantity, sales: x._sum.total })) });
  } catch (error) { return next(error); }
});
// Completed sales and service fee per attendant, the base for tip/commission distribution rules defined by the restaurant.
reportsRoutes.get('/waiters', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const scope = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const rows = await prisma.order.groupBy({ by: ['createdByUserId'], where: { ...scope, status: 'COMPLETED', createdAt: { gte: from, lte: to } }, _sum: { subtotal: true, serviceFee: true, total: true }, _count: true });
    const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap(row => row.createdByUserId ? [row.createdByUserId] : []) }, tenantId: req.auth!.tenantId! }, select: { id: true, name: true } });
    const names = new Map(users.map(user => [user.id, user.name]));
    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: rows.map(row => ({ userId: row.createdByUserId, name: row.createdByUserId ? names.get(row.createdByUserId) ?? 'Usuário removido' : 'Autoatendimento / sem atendente', orders: row._count, sales: row._sum.subtotal, serviceFee: row._sum.serviceFee, total: row._sum.total })) });
  } catch (error) { return next(error); }
});
