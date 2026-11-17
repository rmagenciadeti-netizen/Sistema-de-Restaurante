import { Router } from 'express';
import { OrderChannel, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { applyStatusSideEffects } from '../lib/order-effects';
import { consumeOrderInventory, canTransitionOrder, OrderInventoryError } from '../lib/order-inventory';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { createOrder, OrderEngineError } from '../lib/order-engine';
import { ALL_TENANT_ROLES, requireRoles, PRODUCTION_ROLES, SALES_ROLES } from '../lib/permissions';

export const orderRoutes = Router();
orderRoutes.use(requireAuth, requireTenant, requireRoles(...ALL_TENANT_ROLES));
const createSchema = z.object({
  unitId: z.string().uuid().optional(),
  channel: z.nativeEnum(OrderChannel).default(OrderChannel.POS),
  customerName: z.string().max(160).optional(),
  customerPhone: z.string().max(30).optional(),
  marketingConsent: z.boolean().optional(),
  tableId: z.string().uuid().optional(),
  tableLabel: z.string().max(30).optional(),
  couponCode: z.string().max(40).optional(),
  deliveryZoneId: z.string().uuid().optional(),
  applyServiceFee: z.boolean().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(999), notes: z.string().max(500).optional(), modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(30).optional() })).min(1).max(100),
});
orderRoutes.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const [items, total] = await Promise.all([prisma.order.findMany({ where, include: { items: { include: { product: true, modifiers: true } }, payments: { where: { status: 'CONFIRMED' }, select: { amount: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.order.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
orderRoutes.post('/', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (parsed.data.customerPhone && !parsed.data.customerName) return res.status(400).json({ message: 'customerName is required with customerPhone' });
    const { customerName, customerPhone, marketingConsent, ...rest } = parsed.data;
    const order = await serializable(prisma, tx => createOrder(tx, {
      ...rest, tenantId, unitId, actorUserId: req.auth!.userId,
      customer: customerName ? { name: customerName, phone: customerPhone, marketingConsent } : undefined,
    }));
    return res.status(201).json(order);
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason });
    return next(error);
  }
});
orderRoutes.patch('/:id/status', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const status = z.nativeEnum(OrderStatus).safeParse(req.body?.status); if (!status.success) return res.status(400).json({ message: 'Invalid order status' });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({
        where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}) },
        include: {
          customer: true,
          items: {
            include: {
              product: {
                include: {
                  recipe: {
                    include: { ingredients: { include: { ingredient: true } } },
                  },
                },
              },
            },
          },
        },
      });
      if (!order) return { kind: 'error', message: 'Order not found', status: 404 } as const;
      if (!canTransitionOrder(order.status, status.data)) return { kind: 'error', message: 'Invalid order status transition', status: 409 } as const;
      if (order.status === status.data) return { kind: 'ok', order } as const;

      if (status.data === OrderStatus.PREPARING) await consumeOrderInventory(tx, order, userId);
      const updated = await tx.order.update({ where: { id: order.id }, data: { status: status.data } });
      await applyStatusSideEffects(tx, order, status.data);
      await tx.auditLog.create({ data: { tenantId: order.tenantId, actorUserId: userId, action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: order.id, metadata: { status: status.data } } });
      return { kind: 'ok', order: updated } as const;
    });
    if (result.kind === 'error') return res.status(result.status).json({ message: result.message });
    return res.json(result.order);
  } catch (error) {
    if (error instanceof OrderInventoryError) {
      const message = error.reason === 'INSUFFICIENT_STOCK' ? 'Insufficient stock to start preparing this order' : 'Order recipe contains invalid or out-of-scope ingredients';
      return res.status(409).json({ message });
    }
    return next(error);
  }
});
