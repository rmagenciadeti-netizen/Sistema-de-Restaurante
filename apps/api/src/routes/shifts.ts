import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, allowRead, MANAGEMENT_ROLES } from '../lib/permissions';

export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;

export const shiftRoutes = Router();
shiftRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));
const schema = z.object({ employeeId: z.string().uuid(), unitId: z.string().uuid().optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(), position: z.string().max(100).optional(), notes: z.string().max(300).optional() });
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});

shiftRoutes.get('/', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date(from.getTime() + 7 * 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const items = await prisma.shift.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req), ...(employeeId ? { employeeId } : {}), startsAt: { lt: to }, endsAt: { gt: from } }, include: { employee: { select: { id: true, fullName: true, position: true } } }, orderBy: { startsAt: 'asc' }, take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

type Tx = Parameters<Parameters<typeof serializable>[1]>[0];
const overlaps = (tx: Tx, tenantId: string, employeeId: string, startsAt: Date, endsAt: Date, ignoreId?: string) =>
  tx.shift.findFirst({ where: { tenantId, employeeId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });

shiftRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (!unitId) return res.status(400).json({ message: 'unitId is required' });
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    const startsAt = new Date(parsed.data.startsAt); const endsAt = new Date(parsed.data.endsAt);
    if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > MAX_SHIFT_MS) return res.status(400).json({ message: 'Shift must end after it starts and last at most 16 hours' });
    const result = await serializable(prisma, async tx => {
      if (!await tx.unit.findFirst({ where: { id: unitId, tenantId } })) return { status: 400, message: 'Unit does not belong to this tenant' } as const;
      if (!await tx.employee.findFirst({ where: { id: parsed.data.employeeId, tenantId, status: 'ACTIVE' } })) return { status: 400, message: 'Active employee not found in this tenant' } as const;
      if (await overlaps(tx, tenantId, parsed.data.employeeId, startsAt, endsAt)) return { status: 409, message: 'Employee already has a shift in this period' } as const;
      return { status: 201, shift: await tx.shift.create({ data: { tenantId, unitId, employeeId: parsed.data.employeeId, startsAt, endsAt, position: parsed.data.position, notes: parsed.data.notes } }) } as const;
    });
    if (result.status !== 201) return res.status(result.status).json({ message: result.message });
    return res.status(201).json(result.shift);
  } catch (error) { return next(error); }
});
shiftRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.pick({ startsAt: true, endsAt: true, position: true, notes: true }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const result = await serializable(prisma, async tx => {
      const current = await tx.shift.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) } });
      if (!current) return { status: 404, message: 'Shift not found' } as const;
      const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : current.startsAt; const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : current.endsAt;
      if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > MAX_SHIFT_MS) return { status: 400, message: 'Shift must end after it starts and last at most 16 hours' } as const;
      if (await overlaps(tx, tenantId, current.employeeId, startsAt, endsAt, current.id)) return { status: 409, message: 'Employee already has a shift in this period' } as const;
      return { status: 200, shift: await tx.shift.update({ where: { id: current.id }, data: { startsAt, endsAt, position: parsed.data.position, notes: parsed.data.notes } }) } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json(result.shift);
  } catch (error) { return next(error); }
});
shiftRoutes.delete('/:id', async (req, res, next) => {
  try {
    const removed = await prisma.shift.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req) } });
    return removed.count === 1 ? res.status(204).end() : res.status(404).json({ message: 'Shift not found' });
  } catch (error) { return next(error); }
});
