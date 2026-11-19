import { Router } from 'express';
import { OrderChannel, OrderStatus, Prisma } from '@prisma/client';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { createOrder, OrderEngineError } from '../lib/order-engine';
import { hiddenCategoryIds } from '../lib/menu-visibility';
import { effectiveUnitPrice } from '../lib/promotions';
import { loadSettings } from '../lib/settings';
import { positiveQuantitySchema } from '../lib/money';

export const MAX_OPEN_ORDERS_PER_TABLE = 10;
export const publicRoutes = Router();

async function resolveTable(qrToken: string) {
  if (!/^[\w-]{20,64}$/.test(qrToken)) return null;
  const table = await prisma.restaurantTable.findUnique({ where: { qrToken }, include: { tenant: { select: { name: true, status: true } }, unit: { select: { id: true, name: true, status: true, serviceFeePercent: true } } } });
  if (!table || !table.active || !['ACTIVE', 'TRIAL'].includes(table.tenant.status) || table.unit.status !== 'ACTIVE') return null;
  return table;
}

publicRoutes.get('/tables/:qrToken/menu', async (req, res, next) => {
  try {
    const table = await resolveTable(req.params.qrToken); if (!table) return res.status(404).json({ message: 'Table not found' });
    const settings = await loadSettings(prisma, table.tenantId);
    if (!settings.fulfillment.allowDineIn) return res.status(409).json({ message: 'DINE_IN_DISABLED' });
    const now = new Date();
    const [hidden, promotionRows] = await Promise.all([
      hiddenCategoryIds(prisma, table.tenantId, now),
      prisma.promotion.findMany({ where: { tenantId: table.tenantId, active: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gte: now } }] }, include: { products: { select: { productId: true } } } }),
    ]);
    const promotions = promotionRows.map(row => ({ type: row.type, value: row.value, startsAt: row.startsAt, endsAt: row.endsAt, active: row.active, productIds: row.products.map(link => link.productId) }));
    // Weighed products need a scale reading, which the self-service QR order cannot provide.
    const products = await prisma.product.findMany({ where: { tenantId: table.tenantId, active: true, soldByWeight: false, ...(hidden.size ? { OR: [{ categoryId: null }, { categoryId: { notIn: [...hidden] } }] } : {}), AND: [{ OR: [{ unitId: table.unitId }, { unitId: null }] }] }, select: { id: true, name: true, description: true, price: true, isCombo: true, allowFractionalQuantity: true, packagingEnabled: true, packagingPrice: true, category: { select: { id: true, name: true } }, comboComponents: { select: { quantity: true, product: { select: { name: true } } } }, modifierGroups: { select: { group: { select: { id: true, name: true, minSelect: true, maxSelect: true, active: true, options: { where: { active: true }, select: { id: true, name: true, price: true }, orderBy: { name: 'asc' } } } } } } }, orderBy: { name: 'asc' }, take: 500 });
    const categories = new Map<string, { id: string | null; name: string; products: unknown[] }>();
    for (const { category, modifierGroups, ...rest } of products) {
      const promoPrice = effectiveUnitPrice(rest.id, rest.price, promotions, now);
      const product = { ...rest, ...(promoPrice.lt(rest.price) ? { promoPrice: promoPrice.toFixed(2) } : {}), modifierGroups: modifierGroups.map(link => link.group).filter(group => group.active && group.options.length > 0).map(({ active: _active, ...group }) => group) };
      const key = category?.id ?? 'none';
      if (!categories.has(key)) categories.set(key, { id: category?.id ?? null, name: category?.name ?? 'Outros', products: [] });
      categories.get(key)!.products.push(product);
    }
    return res.json({ restaurant: table.tenant.name, unit: table.unit.name, table: table.label, serviceFeePercent: table.unit.serviceFeePercent, categories: [...categories.values()] });
  } catch (error) { return next(error); }
});

const orderSchema = z.object({
  customerName: z.string().min(1).max(160).optional(),
  customerPhone: z.string().max(30).optional(),
  marketingConsent: z.boolean().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: positiveQuantitySchema(20), withPackaging: z.boolean().optional(), notes: z.string().max(200).optional(), modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(20).optional() })).min(1).max(30),
});
publicRoutes.post('/tables/:qrToken/orders', async (req, res, next) => {
  try {
    const parsed = orderSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (parsed.data.customerPhone && !parsed.data.customerName) return res.status(400).json({ message: 'customerName is required with customerPhone' });
    const table = await resolveTable(req.params.qrToken); if (!table) return res.status(404).json({ message: 'Table not found' });
    const settings = await loadSettings(prisma, table.tenantId);
    if (!settings.fulfillment.allowDineIn) return res.status(409).json({ message: 'DINE_IN_DISABLED' });
    const open = await prisma.order.count({ where: { tableId: table.id, status: { in: [OrderStatus.OPEN, OrderStatus.PREPARING, OrderStatus.READY] } } });
    if (open >= MAX_OPEN_ORDERS_PER_TABLE) return res.status(429).json({ message: 'Too many open orders for this table. Call a waiter.' });
    const { customerName, customerPhone, marketingConsent, items } = parsed.data;
    const order = await serializable(prisma, tx => createOrder(tx, {
      tenantId: table.tenantId, unitId: table.unitId, channel: OrderChannel.TABLE, tableId: table.id, items, notifyCustomer: false, holdForConfirmation: settings.fulfillment.qrConfirmation,
      customer: customerName ? { name: customerName, phone: customerPhone, marketingConsent, untrusted: true } : undefined,
    }));
    return res.status(201).json({ id: order.id, code: order.code, status: order.status, total: order.total, serviceFee: order.serviceFee, awaitingConfirmation: settings.fulfillment.qrConfirmation });
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason === 'FRACTIONAL_QUANTITY_NOT_ALLOWED' ? 'Este produto não permite quantidade fracionada.' : error.reason === 'PACKAGING_NOT_ALLOWED' ? 'Este produto não permite embalagem.' : error.reason });
    return next(error);
  }
});

// What the customer sees on the table: the open account (orders still in progress, plus refusals of the last 2 hours) and the calls already made.
publicRoutes.get('/tables/:qrToken/orders', async (req, res, next) => {
  try {
    const table = await resolveTable(req.params.qrToken); if (!table) return res.status(404).json({ message: 'Table not found' });
    const since = new Date(Date.now() - 2 * 3_600_000);
    const [orders, requests] = await Promise.all([
      prisma.order.findMany({
        where: { tableId: table.id, tenantId: table.tenantId, OR: [{ status: { in: [OrderStatus.OPEN, OrderStatus.PREPARING, OrderStatus.READY] } }, { status: OrderStatus.CANCELLED, updatedAt: { gte: since } }] },
        orderBy: { createdAt: 'asc' }, take: 50,
        select: { id: true, code: true, status: true, holdReason: true, releasedAt: true, total: true, serviceFee: true, createdAt: true, items: { where: { parentItemId: null }, select: { id: true, quantity: true, status: true, product: { select: { name: true } } } } },
      }),
      prisma.tableRequest.findMany({ where: { tableId: table.id, status: 'OPEN' }, select: { type: true, createdAt: true } }),
    ]);
    const open = orders.filter(order => order.status !== OrderStatus.CANCELLED);
    return res.json({
      table: table.label,
      orders: orders.map(order => ({ id: order.id, code: order.code, status: order.status, awaitingConfirmation: order.holdReason === 'QR_CONFIRMATION' && order.releasedAt === null && order.status === OrderStatus.OPEN, refused: order.status === OrderStatus.CANCELLED, total: order.total, createdAt: order.createdAt, items: order.items.map(item => ({ name: item.product.name, quantity: item.quantity, status: item.status })) })),
      accountTotal: open.reduce((sum, order) => sum.add(order.total), new Prisma.Decimal(0)).toFixed(2),
      requests: requests.map(request => request.type),
    });
  } catch (error) { return next(error); }
});

const requestLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => `${req.ip}:${req.params.qrToken}`, message: { message: 'Muitas solicitações. Chame um atendente.' } });
publicRoutes.post('/tables/:qrToken/requests', requestLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ type: z.enum(['WAITER', 'BILL']), note: z.string().trim().max(120).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const table = await resolveTable(req.params.qrToken); if (!table) return res.status(404).json({ message: 'Table not found' });
    // A repeated tap does not create another call: the open one is kept (and reported as such).
    const existing = await prisma.tableRequest.findFirst({ where: { tableId: table.id, type: parsed.data.type, status: 'OPEN' }, select: { id: true } });
    if (existing) return res.status(200).json({ id: existing.id, type: parsed.data.type, status: 'OPEN', duplicate: true });
    const created = await prisma.tableRequest.create({ data: { tenantId: table.tenantId, unitId: table.unitId, tableId: table.id, type: parsed.data.type, note: parsed.data.note } });
    return res.status(201).json({ id: created.id, type: created.type, status: created.status, duplicate: false });
  } catch (error) { return next(error); }
});
