import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';

export const tenantRoutes = Router();
tenantRoutes.use(requireAuth, requireMaster);
tenantRoutes.get('/', async (_req, res, next) => {
  try { const items = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { units: true, users: true } } } }); return res.json({ total: items.length, items }); }
  catch (error) { return next(error); }
});
tenantRoutes.get('/stats/summary', async (_req, res, next) => {
  try {
    const [total, active, trial, suspended] = await Promise.all([
      prisma.tenant.count(), prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.tenant.count({ where: { status: 'TRIAL' } }), prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
    ]);
    return res.json({ total, active, trial, suspended });
  } catch (error) { return next(error); }
});
tenantRoutes.patch('/:id/status', async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!['ACTIVE', 'TRIAL', 'SUSPENDED', 'BLOCKED'].includes(status)) return res.status(400).json({ message: 'Invalid tenant status' });
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: { status } });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_STATUS_CHANGED', entityType: 'Tenant', entityId: tenant.id, metadata: { status } } });
    return res.json(tenant);
  } catch (error) { return next(error); }
});
void UserRole;
