import { Router } from 'express';
import { OrderChannel, OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { createOrder, OrderEngineError } from '../lib/order-engine';

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
    const products = await prisma.product.findMany({ where: { tenantId: table.tenantId, active: true, OR: [{ unitId: table.unitId }, { unitId: null }] }, select: { id: true, name: true, description: true, price: true, isCombo: true, category: { select: { id: true, name: true } }, comboComponents: { select: { quantity: true, product: { select: { name: true } } } }, modifierGroups: { select: { group: { select: { id: true, name: true, minSelect: true, maxSelect: true, active: true, options: { where: { active: true }, select: { id: true, name: true, price: true }, orderBy: { name: 'asc' } } } } } } }, orderBy: { name: 'asc' }, take: 500 });
    const categories = new Map<string, { id: string | null; name: string; products: unknown[] }>();
    for (const { category, modifierGroups, ...rest } of products) {
      const product = { ...rest, modifierGroups: modifierGroups.map(link => link.group).filter(group => group.active && group.options.length > 0).map(({ active: _active, ...group }) => group) };
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
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(20), notes: z.string().max(200).optional(), modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(20).optional() })).min(1).max(30),
});
publicRoutes.post('/tables/:qrToken/orders', async (req, res, next) => {
  try {
    const parsed = orderSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (parsed.data.customerPhone && !parsed.data.customerName) return res.status(400).json({ message: 'customerName is required with customerPhone' });
    const table = await resolveTable(req.params.qrToken); if (!table) return res.status(404).json({ message: 'Table not found' });
    const open = await prisma.order.count({ where: { tableId: table.id, status: { in: [OrderStatus.OPEN, OrderStatus.PREPARING, OrderStatus.READY] } } });
    if (open >= MAX_OPEN_ORDERS_PER_TABLE) return res.status(429).json({ message: 'Too many open orders for this table. Call a waiter.' });
    const { customerName, customerPhone, marketingConsent, items } = parsed.data;
    const order = await serializable(prisma, tx => createOrder(tx, {
      tenantId: table.tenantId, unitId: table.unitId, channel: OrderChannel.TABLE, tableId: table.id, items,
      customer: customerName ? { name: customerName, phone: customerPhone, marketingConsent, untrusted: true } : undefined,
    }));
    return res.status(201).json({ id: order.id, code: order.code, status: order.status, total: order.total, serviceFee: order.serviceFee });
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason });
    return next(error);
  }
});
