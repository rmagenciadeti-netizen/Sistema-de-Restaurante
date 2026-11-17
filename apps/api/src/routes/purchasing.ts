import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, Prisma, PurchaseStatus, StockMovementType } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';

export const purchasingRoutes = Router();
purchasingRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});
const supplierSchema = z.object({ name: z.string().min(2).max(160), document: z.string().max(20).optional(), phone: z.string().max(30).optional(), email: z.string().email().optional() });

purchasingRoutes.get('/suppliers', async (req, res, next) => {
  try { const items = await prisma.supplier.findMany({ where: { tenantId: req.auth!.tenantId!, active: true }, orderBy: { name: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
purchasingRoutes.post('/suppliers', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = supplierSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (await prisma.supplier.findUnique({ where: { tenantId_name: { tenantId, name: parsed.data.name } } })) return res.status(409).json({ message: 'Supplier already exists' });
    return res.status(201).json(await prisma.supplier.create({ data: { ...parsed.data, tenantId } }));
  } catch (error) { return next(error); }
});
purchasingRoutes.patch('/suppliers/:id', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = supplierSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Supplier not found' });
    return res.json(await prisma.supplier.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});

const purchaseSchema = z.object({
  supplierId: z.string().uuid(), unitId: z.string().uuid().optional(), dueAt: z.string().datetime().optional(), notes: z.string().max(500).optional(),
  items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive().max(99999999), unitCost: z.number().nonnegative().max(9999999) })).min(1).max(200),
});
purchasingRoutes.get('/orders', async (req, res, next) => {
  try { const items = await prisma.purchaseOrder.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req) }, include: { supplier: { select: { id: true, name: true } }, items: { include: { ingredient: { select: { id: true, name: true, unitOfMeasure: true } } } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
purchasingRoutes.post('/orders', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = purchaseSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (!await prisma.supplier.findFirst({ where: { id: parsed.data.supplierId, tenantId, active: true } })) return res.status(400).json({ message: 'Supplier does not belong to this tenant' });
    const ingredientIds = [...new Set(parsed.data.items.map(item => item.ingredientId))];
    const ingredients = await prisma.ingredient.findMany({ where: { id: { in: ingredientIds }, tenantId, active: true, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) } });
    if (ingredients.length !== ingredientIds.length) return res.status(400).json({ message: 'Ingredients unavailable in this tenant or unit' });
    const total = parsed.data.items.reduce((sum, item) => sum.add(new Prisma.Decimal(item.quantity).mul(item.unitCost)), new Prisma.Decimal(0)).toDecimalPlaces(2);
    const purchase = await prisma.purchaseOrder.create({
      data: { tenantId, unitId, supplierId: parsed.data.supplierId, code: `C-${Date.now().toString(36).toUpperCase()}${randomInt(1296).toString(36).toUpperCase().padStart(2, '0')}`, total, notes: parsed.data.notes, dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : undefined, items: { create: parsed.data.items } },
      include: { items: true },
    });
    return res.status(201).json(purchase);
  } catch (error) { return next(error); }
});
purchasingRoutes.post('/orders/:id/cancel', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const updated = await prisma.purchaseOrder.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req), status: PurchaseStatus.DRAFT }, data: { status: PurchaseStatus.CANCELLED } });
    if (updated.count !== 1) return res.status(409).json({ message: 'Only draft purchases of this tenant can be cancelled' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

// Receiving updates stock, weighted-average cost and creates the payable in one serializable transaction.
purchasingRoutes.post('/orders/:id/receive', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const { tenantId, userId } = { tenantId: req.auth!.tenantId!, userId: req.auth!.userId };
    const result = await serializable(prisma, async tx => {
      const purchase = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) }, include: { items: true, supplier: true } });
      if (!purchase) return { status: 404, message: 'Purchase not found' } as const;
      if (purchase.status !== PurchaseStatus.DRAFT) return { status: 409, message: 'Purchase already received or cancelled' } as const;
      for (const item of purchase.items) {
        const ingredient = await tx.ingredient.findFirst({ where: { id: item.ingredientId, tenantId } });
        if (!ingredient) return { status: 409, message: 'Purchase references an unavailable ingredient' } as const;
        const newStock = ingredient.currentStock.add(item.quantity);
        const averageCost = ingredient.currentStock.mul(ingredient.averageCost).add(item.quantity.mul(item.unitCost)).div(newStock).toDecimalPlaces(4);
        await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: newStock, averageCost } });
        await tx.stockMovement.create({ data: { tenantId, unitId: purchase.unitId ?? ingredient.unitId, ingredientId: ingredient.id, type: StockMovementType.PURCHASE, quantity: item.quantity, unitCost: item.unitCost, reference: purchase.id, note: `Purchase ${purchase.code}`, actorUserId: userId } });
      }
      const updated = await tx.purchaseOrder.update({ where: { id: purchase.id }, data: { status: PurchaseStatus.RECEIVED, receivedAt: new Date() } });
      await tx.financialEntry.create({ data: { tenantId, unitId: purchase.unitId, description: `Compra ${purchase.code} - ${purchase.supplier.name}`, type: FinancialEntryType.EXPENSE, category: 'Compras', amount: purchase.total, dueAt: purchase.dueAt, status: FinancialEntryStatus.OPEN, reference: purchase.id } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: userId, action: 'PURCHASE_RECEIVED', entityType: 'PurchaseOrder', entityId: purchase.id } });
      return { status: 200, purchase: updated } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json(result.purchase);
  } catch (error) { return next(error); }
});
