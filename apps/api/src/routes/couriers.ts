import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { activeFilter, audit, listQuerySchema, optionalText, resolveUnit, unitReadScope, validationError } from '../lib/registry';

export const courierRoutes = Router();
courierRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const schema = z.object({ name: z.string().trim().min(2).max(160), phone: optionalText(30), unitId: z.string().uuid().nullish(), paymentPerDelivery: z.number().min(0).max(9999.99).multipleOf(0.01).nullish(), commissionPercent: z.number().min(0).max(100).multipleOf(0.01).nullish(), active: z.boolean().default(true) });
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

// Individual courier report: deliveries, average delivery time and what is owed (payout frozen when each delivery was concluded).
courierRoutes.get('/:id/report', async (req, res, next) => {
  try {
    const period = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).safeParse(req.query);
    if (!period.success) return res.status(400).json({ message: 'Invalid date range' });
    const to = period.data.to ? new Date(period.data.to) : new Date(); const from = period.data.from ? new Date(period.data.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from > to) return res.status(400).json({ message: 'Invalid date range' });
    const courier = await prisma.courier.findFirst({ where: scope(req, { id: req.params.id }), select: { id: true, name: true, paymentPerDelivery: true, commissionPercent: true } });
    if (!courier) return res.status(404).json({ message: 'Entregador não encontrado.' });
    const jobs = await prisma.deliveryJob.findMany({ where: { tenantId: req.auth!.tenantId!, courierId: courier.id, status: 'DELIVERED', deliveredAt: { gte: from, lte: to } }, orderBy: { deliveredAt: 'desc' }, take: 1000, select: { id: true, dispatchedAt: true, deliveredAt: true, payout: true, address: true, order: { select: { code: true, deliveryFee: true, total: true } } } });
    const minutes = jobs.flatMap(job => (job.dispatchedAt && job.deliveredAt ? [(job.deliveredAt.getTime() - job.dispatchedAt.getTime()) / 60_000] : []));
    const payout = jobs.reduce((sum, job) => sum + Number(job.payout ?? 0), 0);
    return res.json({
      courier, period: { from, to }, deliveries: jobs.length, averageMinutes: minutes.length ? Math.round((minutes.reduce((sum, value) => sum + value, 0) / minutes.length) * 10) / 10 : null,
      deliveryFees: Math.round(jobs.reduce((sum, job) => sum + Number(job.order.deliveryFee), 0) * 100) / 100, totalOwed: Math.round(payout * 100) / 100,
      items: jobs.map(job => ({ id: job.id, order: job.order.code, address: job.address, dispatchedAt: job.dispatchedAt, deliveredAt: job.deliveredAt, minutes: job.dispatchedAt && job.deliveredAt ? Math.round(((job.deliveredAt.getTime() - job.dispatchedAt.getTime()) / 60_000) * 10) / 10 : null, deliveryFee: job.order.deliveryFee, payout: job.payout })),
      note: 'O valor devido é congelado na entrega concluída; entregas anteriores ao cadastro de pagamento/comissão aparecem sem valor.',
    });
  } catch (error) { return next(error); }
});

courierRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const unit = await resolveUnit(req, parsed.data.unitId); if ('error' in unit) return res.status(unit.status).json({ message: unit.error });
    const created = await prisma.courier.create({ data: { tenantId: req.auth!.tenantId!, name: parsed.data.name, phone: parsed.data.phone, active: parsed.data.active, paymentPerDelivery: parsed.data.paymentPerDelivery ?? null, commissionPercent: parsed.data.commissionPercent ?? null, unitId: unit.unitId } });
    await audit(req, 'COURIER_CREATED', 'Courier', created.id);
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});

courierRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.courier.findFirst({ where: scope(req, { id: req.params.id }) }); if (!current) return res.status(404).json({ message: 'Entregador não encontrado.' });
    const data: { name?: string; phone?: string | null; active?: boolean; unitId?: string | null; paymentPerDelivery?: number | null; commissionPercent?: number | null } = { name: parsed.data.name, phone: parsed.data.phone, active: parsed.data.active, paymentPerDelivery: parsed.data.paymentPerDelivery, commissionPercent: parsed.data.commissionPercent };
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
