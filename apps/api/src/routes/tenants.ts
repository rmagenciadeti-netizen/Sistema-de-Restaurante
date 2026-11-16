import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';

export const tenantRoutes = Router();
tenantRoutes.use(requireAuth, requireMaster);
const createSchema = z.object({ name: z.string().min(2).max(160), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), plan: z.enum(['BASIC', 'PRO', 'PREMIUM', 'ENTERPRISE']).default('BASIC'), adminName: z.string().min(2).max(160), adminEmail: z.string().email().transform(value => value.toLowerCase()), adminPassword: z.string().min(12).max(200), unitName: z.string().min(2).max(100).default('Matriz') });
tenantRoutes.get('/', async (_req, res, next) => {
  try { const items = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { units: true, users: true } } } }); return res.json({ total: items.length, items }); }
  catch (error) { return next(error); }
});
tenantRoutes.get('/stats/summary', async (_req, res, next) => {
  try {
    const [total, active, trial, suspended] = await Promise.all([prisma.tenant.count(), prisma.tenant.count({ where: { status: 'ACTIVE' } }), prisma.tenant.count({ where: { status: 'TRIAL' } }), prisma.tenant.count({ where: { status: { in: ['SUSPENDED', 'BLOCKED'] } } })]);
    return res.json({ total, active, trial, suspended });
  } catch (error) { return next(error); }
});
tenantRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { name, slug, plan, adminName, adminEmail, adminPassword, unitName } = parsed.data;
    if (await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } })) return res.status(409).json({ message: 'E-mail já cadastrado' });
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const created = await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({ data: { name, slug, plan, status: 'TRIAL' } });
      const unit = await tx.unit.create({ data: { tenantId: tenant.id, name: unitName, code: 'MATRIZ' } });
      const user = await tx.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: adminName, email: adminEmail, passwordHash, role: 'ADMIN' } });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_CREATED', entityType: 'Tenant', entityId: tenant.id } });
      return { tenant, unit, admin: { id: user.id, name: user.name, email: user.email } };
    });
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});
tenantRoutes.patch('/:id/status', async (req, res, next) => {
  try {
    const status = z.enum(['ACTIVE', 'TRIAL', 'SUSPENDED', 'BLOCKED']).safeParse(req.body?.status);
    if (!status.success) return res.status(400).json({ message: 'Invalid tenant status' });
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: { status: status.data } });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_STATUS_CHANGED', entityType: 'Tenant', entityId: tenant.id, metadata: { status: status.data } } });
    return res.json(tenant);
  } catch (error) { return next(error); }
});
