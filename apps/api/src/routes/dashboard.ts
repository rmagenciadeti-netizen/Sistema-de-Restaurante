import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster, requireTenant } from '../middleware/auth';

export const dashboardRoutes = Router();
dashboardRoutes.get('/master', requireAuth, requireMaster, async (_req, res, next) => {
  try {
    const [totalCompanies, activeCompanies, trialCompanies, suspendedCompanies, users, orders, products] = await Promise.all([
      prisma.tenant.count(), prisma.tenant.count({ where: { status: 'ACTIVE' } }), prisma.tenant.count({ where: { status: 'TRIAL' } }),
      prisma.tenant.count({ where: { status: { in: ['SUSPENDED', 'BLOCKED'] } } }), prisma.user.count(), prisma.order.count(), prisma.product.count(),
    ]);
    return res.json({ totalCompanies, activeCompanies, trialCompanies, suspendedCompanies, users, orders, products, note: 'Financial and infrastructure metrics require configured billing and monitoring integrations.' });
  } catch (error) { return next(error); }
});
dashboardRoutes.get('/restaurant', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const unitFilter = req.auth!.unitId ? { unitId: req.auth!.unitId } : {};
    const [products, employees, orders, openOrders] = await Promise.all([
      prisma.product.count({ where: { tenantId, ...unitFilter, active: true } }),
      prisma.employee.count({ where: { tenantId, ...unitFilter, status: 'ACTIVE' } }),
      prisma.order.count({ where: { tenantId, ...unitFilter } }),
      prisma.order.count({ where: { tenantId, ...unitFilter, status: { in: ['OPEN', 'PREPARING', 'READY'] } } }),
    ]);
    return res.json({ products, employees, orders, openOrders });
  } catch (error) { return next(error); }
});
