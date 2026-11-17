import { Router } from 'express';
import { DeliveryStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, DELIVERY_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { moneySchema } from '../lib/money';

export const deliveryRoutes = Router();
deliveryRoutes.use(requireAuth, requireTenant, requireRoles(...DELIVERY_ROLES));
const zoneSchema = z.object({ name: z.string().min(2).max(100), fee: moneySchema, minOrder: moneySchema.optional(), unitId: z.string().uuid().optional() });
deliveryRoutes.get('/zones', allowRead(DELIVERY_ROLES, MANAGEMENT_ROLES), async (req, res, next) => {
  try { const items = await prisma.deliveryZone.findMany({ where: { tenantId: req.auth!.tenantId!, active: true, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
deliveryRoutes.post('/zones', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = zoneSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId ?? null;
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (await prisma.deliveryZone.findFirst({ where: { tenantId, unitId, name: parsed.data.name } })) return res.status(409).json({ message: 'Zone already exists' });
    return res.status(201).json(await prisma.deliveryZone.create({ data: { ...parsed.data, tenantId, unitId } }));
  } catch (error) { return next(error); }
});
deliveryRoutes.patch('/zones/:id', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ fee: moneySchema, minOrder: moneySchema.nullable(), active: z.boolean() }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.deliveryZone.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!current) return res.status(404).json({ message: 'Zone not found' });
    return res.json(await prisma.deliveryZone.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});
deliveryRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.deliveryJob.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { order: { include: { items: { include: { product: true } } } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
deliveryRoutes.post('/', async (req, res, next) => {
  try { const input = z.object({ orderId: z.string().uuid(), courierName: z.string().max(160).optional(), courierPhone: z.string().max(30).optional(), address: z.string().max(500).optional(), provider: z.string().max(80).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const tenantId = req.auth!.tenantId!; const order = await prisma.order.findFirst({ where: { id: input.data.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), channel: 'DELIVERY' } }); if (!order) return res.status(404).json({ message: 'Delivery order not found' }); const job = await prisma.deliveryJob.create({ data: { ...input.data, tenantId, unitId: order.unitId } }); return res.status(201).json(job); }
  catch (error) { return next(error); }
});
deliveryRoutes.patch('/:id/status', async (req, res, next) => {
  try { const status = z.nativeEnum(DeliveryStatus).safeParse(req.body?.status); if (!status.success) return res.status(400).json({ message: 'Invalid delivery status' }); const job = await prisma.deliveryJob.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!job) return res.status(404).json({ message: 'Delivery job not found' }); const updated = await prisma.deliveryJob.update({ where: { id: job.id }, data: { status: status.data, ...(status.data === 'PICKED_UP' ? { dispatchedAt: new Date() } : {}), ...(status.data === 'DELIVERED' ? { deliveredAt: new Date() } : {}) } }); return res.json(updated); }
  catch (error) { return next(error); }
});
