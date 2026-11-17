import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, MANAGEMENT_ROLES, allowRead } from '../lib/permissions';

export const unitRoutes = Router();
unitRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));
const schema = z.object({ name: z.string().min(2).max(100), code: z.string().max(30).optional(), address: z.string().max(500).optional(), serviceFeePercent: z.number().min(0).max(30).multipleOf(0.01).optional(), waiterSharePercent: z.number().min(0).max(100).multipleOf(0.01).optional() });
unitRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.unit.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { id: req.auth!.unitId } : {}) }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
unitRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (req.auth!.unitId) return res.status(403).json({ message: 'Only tenant-wide administrators can create units' });
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
