import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const employeeRoutes = Router();
employeeRoutes.use(requireAuth, requireTenant);
const schema = z.object({ fullName: z.string().min(2).max(160), cpf: z.string().max(20).optional(), phone: z.string().max(30).optional(), email: z.string().email().optional(), position: z.string().max(100).optional(), unitId: z.string().uuid().optional() });
const scope = (req: Parameters<typeof employeeRoutes.get>[1] extends never ? never : any) => ({ tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) });
employeeRoutes.get('/', async (req, res, next) => {
  try { const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25)); const where = scope(req); const [items, total] = await Promise.all([prisma.employee.findMany({ where, orderBy: { fullName: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.employee.count({ where })]); return res.json({ items, total, page, pageSize }); }
  catch (error) { return next(error); }
});
employeeRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { unitId, ...data } = parsed.data; const selectedUnit = unitId ?? req.auth!.unitId;
    if (selectedUnit && !await prisma.unit.findFirst({ where: { id: selectedUnit, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const employee = await prisma.employee.create({ data: { ...data, tenantId: req.auth!.tenantId!, unitId: selectedUnit } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: employee.id } });
    return res.status(201).json(employee);
  } catch (error) { return next(error); }
});
employeeRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const where = { id: req.params.id, ...scope(req) }; const current = await prisma.employee.findFirst({ where }); if (!current) return res.status(404).json({ message: 'Employee not found' });
    if (parsed.data.unitId && !await prisma.unit.findFirst({ where: { id: parsed.data.unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const updated = await prisma.employee.update({ where: { id: current.id }, data: parsed.data });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: updated.id } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
