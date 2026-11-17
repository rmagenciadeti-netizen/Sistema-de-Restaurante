import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { activeFilter, audit, listQuerySchema, optionalText, resolveUnit, unitReadScope, validationError } from '../lib/registry';

export const courierRoutes = Router();
courierRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const schema = z.object({ name: z.string().trim().min(2).max(160), phone: optionalText(30), unitId: z.string().uuid().nullish(), active: z.boolean().default(true) });
const scope = (req: Parameters<typeof unitReadScope>[0], extra: object = {}) => ({ tenantId: req.auth!.tenantId!, ...unitReadScope(req), ...extra });

courierRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const where = { ...scope(req, { ...activeFilter(active) }), ...(q ? { AND: [{ OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { phone: { contains: q } }] }] } : {}) };
    const items = await prisma.courier.findMany({ where, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

courierRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const unit = await resolveUnit(req, parsed.data.unitId); if ('error' in unit) return res.status(unit.status).json({ message: unit.error });
    const created = await prisma.courier.create({ data: { tenantId: req.auth!.tenantId!, name: parsed.data.name, phone: parsed.data.phone, active: parsed.data.active, unitId: unit.unitId } });
    await audit(req, 'COURIER_CREATED', 'Courier', created.id);
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});

courierRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.courier.findFirst({ where: scope(req, { id: req.params.id }) }); if (!current) return res.status(404).json({ message: 'Entregador não encontrado.' });
    const data: { name?: string; phone?: string | null; active?: boolean; unitId?: string | null } = { name: parsed.data.name, phone: parsed.data.phone, active: parsed.data.active };
    if (parsed.data.unitId !== undefined) {
      const unit = await resolveUnit(req, parsed.data.unitId); if ('error' in unit) return res.status(unit.status).json({ message: unit.error });
      data.unitId = unit.unitId;
    }
    const updated = await prisma.courier.update({ where: { id: current.id }, data });
    await audit(req, parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'COURIER_ACTIVATED' : 'COURIER_DEACTIVATED') : 'COURIER_UPDATED', 'Courier', current.id);
    return res.json(updated);
  } catch (error) { return next(error); }
});

// Couriers that already have deliveries are deactivated instead of deleted.
courierRoutes.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.courier.findFirst({ where: scope(req, { id: req.params.id }) }); if (!current) return res.status(404).json({ message: 'Entregador não encontrado.' });
    if (await prisma.deliveryJob.count({ where: { courierId: current.id } }) > 0) {
      const updated = await prisma.courier.update({ where: { id: current.id }, data: { active: false } });
      await audit(req, 'COURIER_DEACTIVATED', 'Courier', current.id);
      return res.json({ deleted: false, deactivated: true, courier: updated });
    }
    await prisma.courier.delete({ where: { id: current.id } });
    await audit(req, 'COURIER_DELETED', 'Courier', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
