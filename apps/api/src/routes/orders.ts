import { Router } from 'express';
import { OrderChannel, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const orderRoutes = Router();
orderRoutes.use(requireAuth, requireTenant);
const createSchema = z.object({ unitId: z.string().uuid().optional(), channel: z.nativeEnum(OrderChannel).default(OrderChannel.POS), customerName: z.string().max(160).optional(), tableLabel: z.string().max(30).optional(), items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(999), notes: z.string().max(500).optional() })).min(1).max(100) });
orderRoutes.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const [items, total] = await Promise.all([prisma.order.findMany({ where, include: { items: { include: { product: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.order.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
orderRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const ids = [...new Set(parsed.data.items.map((item) => item.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: ids }, tenantId, active: true, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) } });
    if (products.length !== ids.length) return res.status(400).json({ message: 'One or more products are unavailable in this tenant or unit' });
    const byId = new Map(products.map((product) => [product.id, product]));
    const subtotal = parsed.data.items.reduce((sum, line) => sum.add((byId.get(line.productId)!.price).mul(line.quantity)), new Prisma.Decimal(0));
    const order = await prisma.order.create({ data: {
      tenantId, unitId, channel: parsed.data.channel, code: `P-${Date.now()}`, customerName: parsed.data.customerName, tableLabel: parsed.data.tableLabel,
      subtotal, total: subtotal, status: OrderStatus.OPEN,
      items: { create: parsed.data.items.map((line) => { const product = byId.get(line.productId)!; return { productId: product.id, quantity: line.quantity, unitPrice: product.price, total: product.price.mul(line.quantity), notes: line.notes, sectorId: product.sectorId }; }) },
    }, include: { items: { include: { product: true } } } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'ORDER_CREATED', entityType: 'Order', entityId: order.id } });
    return res.status(201).json(order);
  } catch (error) { return next(error); }
});
orderRoutes.patch('/:id/status', async (req, res, next) => {
  try {
    const status = z.nativeEnum(OrderStatus).safeParse(req.body?.status);
    if (!status.success) return res.status(400).json({ message: 'Invalid order status' });
    const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const updated = await prisma.order.update({ where: { id: order.id }, data: { status: status.data } });
    await prisma.auditLog.create({ data: { tenantId: order.tenantId, actorUserId: req.auth!.userId, action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: order.id, metadata: { status: status.data } } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
