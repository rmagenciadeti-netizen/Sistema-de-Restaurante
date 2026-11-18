import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, FINANCE_ROLES, MANAGEMENT_ROLES, allowRead } from '../lib/permissions';

export const unitRoutes = Router();
unitRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));
const schema = z.object({ name: z.string().min(2).max(100), code: z.string().max(30).optional(), address: z.string().max(500).optional(), serviceFeePercent: z.number().min(0).max(30).multipleOf(0.01).optional(), waiterSharePercent: z.number().min(0).max(100).multipleOf(0.01).optional() });
unitRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.unit.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { id: req.auth!.unitId } : {}) }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
// Side-by-side performance of the tenant's units over real completed sales and settled expenses; unit-bound users only see their own unit.
unitRoutes.get('/compare', async (req, res, next) => {
  try {
    if (!FINANCE_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const query = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid period' });
    const now = new Date();
    const from = query.data.from ? new Date(query.data.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.data.to ? new Date(query.data.to) : now;
    if (from > to) return res.status(400).json({ message: 'Invalid period' });
    const tenantId = req.auth!.tenantId!;
    const units = await prisma.unit.findMany({ where: { tenantId, ...(req.auth!.unitId ? { id: req.auth!.unitId } : {}) }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } });
    const unitIds = units.map(unit => unit.id);
    const period = { gte: from, lte: to };
    const [sales, cancelled, expenses, employees, tables] = await Promise.all([
      prisma.order.groupBy({ by: ['unitId'], where: { tenantId, unitId: { in: unitIds }, status: 'COMPLETED', createdAt: period }, _sum: { total: true }, _count: { _all: true } }),
      prisma.order.groupBy({ by: ['unitId'], where: { tenantId, unitId: { in: unitIds }, status: 'CANCELLED', createdAt: period }, _count: { _all: true } }),
      prisma.financialEntry.groupBy({ by: ['unitId'], where: { tenantId, unitId: { in: unitIds }, type: 'EXPENSE', status: 'PAID', settledAt: period }, _sum: { amount: true } }),
      prisma.employee.groupBy({ by: ['unitId'], where: { tenantId, unitId: { in: unitIds }, status: 'ACTIVE' }, _count: { _all: true } }),
      prisma.restaurantTable.groupBy({ by: ['unitId'], where: { tenantId, unitId: { in: unitIds }, active: true }, _count: { _all: true } }),
    ]);
    const items = units.map(unit => {
      const sold = sales.find(row => row.unitId === unit.id);
      const revenue = Number(sold?._sum.total ?? 0); const orders = sold?._count._all ?? 0; const spent = Number(expenses.find(row => row.unitId === unit.id)?._sum.amount ?? 0);
      return { id: unit.id, name: unit.name, status: unit.status, revenue, orders, averageTicket: orders ? Math.round((revenue / orders) * 100) / 100 : 0, cancelledOrders: cancelled.find(row => row.unitId === unit.id)?._count._all ?? 0, expenses: spent, result: Math.round((revenue - spent) * 100) / 100, employees: employees.find(row => row.unitId === unit.id)?._count._all ?? 0, tables: tables.find(row => row.unitId === unit.id)?._count._all ?? 0 };
    });
    const totals = items.reduce((acc, item) => ({ revenue: acc.revenue + item.revenue, orders: acc.orders + item.orders, expenses: acc.expenses + item.expenses }), { revenue: 0, orders: 0, expenses: 0 });
    return res.json({ period: { from, to }, items, totals: { ...totals, averageTicket: totals.orders ? Math.round((totals.revenue / totals.orders) * 100) / 100 : 0, result: Math.round((totals.revenue - totals.expenses) * 100) / 100 } });
  } catch (error) { return next(error); }
});
unitRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (req.auth!.unitId) return res.status(403).json({ message: 'Only tenant-wide administrators can create units' });
    const license = await prisma.tenantLicense.findUnique({ where: { tenantId: req.auth!.tenantId! }, select: { maxUnits: true } });
    if (license?.maxUnits != null && await prisma.unit.count({ where: { tenantId: req.auth!.tenantId! } }) >= license.maxUnits) return res.status(403).json({ message: 'License unit limit reached' });
    const unit = await prisma.unit.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId! } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'UNIT_CREATED', entityType: 'Unit', entityId: unit.id } });
    return res.status(201).json(unit);
  } catch (error) { return next(error); }
});
unitRoutes.patch('/:id', async (req, res, next) => {
  try {
    if (req.auth!.unitId) return res.status(403).json({ message: 'Tenant-wide administrator access required' });
    const parsed = schema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.unit.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } });
    if (!current) return res.status(404).json({ message: 'Unit not found' });
    const unit = await prisma.unit.update({ where: { id: current.id }, data: parsed.data });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'UNIT_UPDATED', entityType: 'Unit', entityId: unit.id } });
    return res.json(unit);
  } catch (error) { return next(error); }
});
