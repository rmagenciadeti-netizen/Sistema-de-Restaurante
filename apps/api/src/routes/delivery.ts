import { Router, type Request } from 'express';
import { DeliveryStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, DELIVERY_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { moneySchema } from '../lib/money';
import { brl, enqueueAutoMessage, orderLabel } from '../lib/whatsapp-auto';

export const deliveryRoutes = Router();
deliveryRoutes.use(requireAuth, requireTenant, requireRoles(...DELIVERY_ROLES));
const findActiveCourier = (req: Request, id: string) => prisma.courier.findFirst({ where: { id, tenantId: req.auth!.tenantId!, active: true, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) } });
const zoneSchema = z.object({ name: z.string().min(2).max(100), fee: moneySchema, minOrder: moneySchema.optional(), estimatedMinutes: z.number().int().min(1).max(600).optional(), unitId: z.string().uuid().optional() });
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
    const parsed = z.object({ fee: moneySchema, minOrder: moneySchema.nullable(), estimatedMinutes: z.number().int().min(1).max(600).nullable(), active: z.boolean() }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.deliveryZone.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!current) return res.status(404).json({ message: 'Zone not found' });
    return res.json(await prisma.deliveryZone.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});
// Delivery central indicators over real deliveries: board totals plus per-courier volume, average time and amount owed.
deliveryRoutes.get('/summary', async (req, res, next) => {
  try {
    const query = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid period' });
    const now = new Date(); const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    const from = query.data.from ? new Date(query.data.from) : start; const to = query.data.to ? new Date(query.data.to) : now;
    if (from > to) return res.status(400).json({ message: 'Invalid period' });
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), createdAt: { gte: from, lte: to } };
    const [jobs, couriers, openNow] = await Promise.all([
      prisma.deliveryJob.findMany({ where, select: { status: true, courierId: true, courierName: true, dispatchedAt: true, deliveredAt: true, order: { select: { total: true, deliveryFee: true } } } }),
      prisma.courier.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }, select: { id: true, name: true, active: true, paymentPerDelivery: true } }),
      prisma.deliveryJob.count({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP'] } } }),
    ]);
    const minutes = (job: (typeof jobs)[number]) => job.dispatchedAt && job.deliveredAt ? (job.deliveredAt.getTime() - job.dispatchedAt.getTime()) / 60_000 : null;
    const timed = jobs.filter(job => job.status === 'DELIVERED' && minutes(job) !== null);
    const byCourier = couriers.map(courier => {
      const mine = jobs.filter(job => job.courierId === courier.id); const done = mine.filter(job => job.status === 'DELIVERED'); const mineTimed = done.filter(job => minutes(job) !== null);
      return { id: courier.id, name: courier.name, active: courier.active, assigned: mine.length, delivered: done.length, averageMinutes: mineTimed.length ? Math.round(mineTimed.reduce((sum, job) => sum + (minutes(job) ?? 0), 0) / mineTimed.length) : null, paymentPerDelivery: courier.paymentPerDelivery === null ? null : Number(courier.paymentPerDelivery), amountDue: courier.paymentPerDelivery === null ? null : Math.round(Number(courier.paymentPerDelivery) * done.length * 100) / 100 };
    }).filter(row => row.assigned > 0 || row.active);
    return res.json({
      period: { from, to }, openNow, total: jobs.length, delivered: jobs.filter(job => job.status === 'DELIVERED').length, cancelled: jobs.filter(job => job.status === 'CANCELLED').length,
      averageMinutes: timed.length ? Math.round(timed.reduce((sum, job) => sum + (minutes(job) ?? 0), 0) / timed.length) : null,
      feesCollected: Math.round(jobs.filter(job => job.status === 'DELIVERED').reduce((sum, job) => sum + Number(job.order.deliveryFee ?? 0), 0) * 100) / 100,
      deliveredRevenue: Math.round(jobs.filter(job => job.status === 'DELIVERED').reduce((sum, job) => sum + Number(job.order.total), 0) * 100) / 100,
      byCourier,
    });
  } catch (error) { return next(error); }
});
deliveryRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.deliveryJob.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { order: { include: { items: { include: { product: true } } } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
deliveryRoutes.post('/', async (req, res, next) => {
  try {
    const input = z.object({ orderId: z.string().uuid(), courierId: z.string().uuid().optional(), courierName: z.string().max(160).optional(), courierPhone: z.string().max(30).optional(), address: z.string().max(500).optional(), provider: z.string().max(80).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const tenantId = req.auth!.tenantId!; const order = await prisma.order.findFirst({ where: { id: input.data.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), channel: 'DELIVERY' } }); if (!order) return res.status(404).json({ message: 'Delivery order not found' });
    const { courierId, ...data } = input.data;
    if (courierId) {
      const courier = await findActiveCourier(req, courierId); if (!courier) return res.status(400).json({ message: 'Entregador inválido ou inativo.' });
      Object.assign(data, { courierName: courier.name, courierPhone: courier.phone ?? undefined });
    }
    const job = await prisma.deliveryJob.create({ data: { ...data, courierId, tenantId, unitId: order.unitId } }); return res.status(201).json(job);
  }
  catch (error) { return next(error); }
});
// Assigns (or clears) the courier of a delivery: a registered courier fills name/phone from the registry; free text stays supported.
deliveryRoutes.patch('/:id/courier', async (req, res, next) => {
  try {
    const input = z.object({ courierId: z.string().uuid().nullish(), courierName: z.string().max(160).nullish(), courierPhone: z.string().max(30).nullish() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const job = await prisma.deliveryJob.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!job) return res.status(404).json({ message: 'Delivery job not found' });
    if (job.status === 'DELIVERED' || job.status === 'CANCELLED') return res.status(409).json({ message: 'Entrega encerrada não pode mudar de entregador.' });
    let data: { courierId: string | null; courierName: string | null; courierPhone: string | null } = { courierId: null, courierName: input.data.courierName || null, courierPhone: input.data.courierPhone || null };
    if (input.data.courierId) {
      const courier = await findActiveCourier(req, input.data.courierId); if (!courier) return res.status(400).json({ message: 'Entregador inválido ou inativo.' });
      data = { courierId: courier.id, courierName: courier.name, courierPhone: courier.phone };
    }
    return res.json(await prisma.deliveryJob.update({ where: { id: job.id }, data }));
  } catch (error) { return next(error); }
});
const notifyOutForDelivery = (order: { id: string; code: string; number: number | null; total: Prisma.Decimal; customer: { name: string; phone: string } | null }, job: { tenantId: string; courierName: string | null }) => {
  if (!order.customer) return Promise.resolve();
  return enqueueAutoMessage(prisma, { tenantId: job.tenantId, key: 'order_out_for_delivery', phone: order.customer.phone, orderId: order.id, vars: { nome: order.customer.name.split(' ')[0], pedido: orderLabel(order), orderCode: order.code, customerName: order.customer.name, total: brl(order.total), entregador: job.courierName ? ` com ${job.courierName}` : '' } }).then(() => undefined).catch(() => undefined);
};
deliveryRoutes.patch('/:id/status', async (req, res, next) => {
  try { const status = z.nativeEnum(DeliveryStatus).safeParse(req.body?.status); if (!status.success) return res.status(400).json({ message: 'Invalid delivery status' }); const job = await prisma.deliveryJob.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!job) return res.status(404).json({ message: 'Delivery job not found' }); const updated = await prisma.deliveryJob.update({ where: { id: job.id }, data: { status: status.data, ...(status.data === 'PICKED_UP' ? { dispatchedAt: new Date() } : {}), ...(status.data === 'DELIVERED' ? { deliveredAt: new Date() } : {}) } }); if (status.data === 'PICKED_UP' && job.status !== 'PICKED_UP') { const order = await prisma.order.findUnique({ where: { id: job.orderId }, include: { customer: { select: { name: true, phone: true } } } }); if (order) await notifyOutForDelivery(order, updated); } return res.json(updated); }
  catch (error) { return next(error); }
});
// One step from the order board: creates the delivery when the order has none, sets the courier and marks it as out for delivery.
deliveryRoutes.post('/orders/:orderId/dispatch', async (req, res, next) => {
  try {
    const input = z.object({ courierId: z.string().uuid().optional(), courierName: z.string().trim().max(160).optional(), courierPhone: z.string().trim().max(30).optional(), address: z.string().trim().max(500).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), channel: 'DELIVERY' }, include: { customer: { select: { name: true, phone: true } }, deliveryJob: true } });
    if (!order) return res.status(404).json({ message: 'Delivery order not found' });
    if (order.status !== 'READY') return res.status(409).json({ message: 'Só pedidos prontos podem sair para entrega.' });
    const current = order.deliveryJob;
    if (current && (current.status === 'DELIVERED' || current.status === 'CANCELLED')) return res.status(409).json({ message: 'Entrega encerrada não pode ser despachada.' });
    let courier: { courierId: string | null; courierName: string | null; courierPhone: string | null } | null = null;
    if (input.data.courierId) {
      const found = await findActiveCourier(req, input.data.courierId); if (!found) return res.status(400).json({ message: 'Entregador inválido ou inativo.' });
      courier = { courierId: found.id, courierName: found.name, courierPhone: found.phone };
    } else if (input.data.courierName) courier = { courierId: null, courierName: input.data.courierName, courierPhone: input.data.courierPhone || null };
    else if (current?.courierName) courier = { courierId: current.courierId, courierName: current.courierName, courierPhone: current.courierPhone };
    if (!courier) return res.status(400).json({ message: 'Escolha o entregador antes de enviar o pedido.' });
    const address = input.data.address || current?.address || undefined;
    const data = { ...courier, ...(address ? { address } : {}), status: 'PICKED_UP' as const, dispatchedAt: new Date() };
    const job = current ? await prisma.deliveryJob.update({ where: { id: current.id }, data }) : await prisma.deliveryJob.create({ data: { ...data, tenantId, unitId: order.unitId, orderId: order.id } });
    if (current?.status !== 'PICKED_UP') await notifyOutForDelivery(order, job);
    return res.status(current ? 200 : 201).json(job);
  } catch (error) { return next(error); }
});
