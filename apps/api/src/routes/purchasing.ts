import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, Prisma, PurchaseStatus, StockMovementType } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { comparePrices, conferencePurchase, earliestExpiry, matchInvoiceItem, type ConferenceLine } from '../lib/stock-planning';

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
// Without a body the whole order is received as requested; with `lines` it is a conference: what actually arrived (quantity/price), the supplier invoice and expiry are recorded and divergences reported.
const receiveSchema = z.object({
  invoiceId: z.string().uuid().optional(), note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ itemId: z.string().uuid(), receivedQuantity: z.number().nonnegative().max(99999999), receivedUnitCost: z.number().nonnegative().max(9999999).optional(), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).max(200).optional(),
});
purchasingRoutes.post('/orders/:id/receive', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const body = receiveSchema.safeParse(req.body ?? {}); if (!body.success) return res.status(400).json({ message: 'Validation failed', errors: body.error.flatten() });
    const { tenantId, userId } = { tenantId: req.auth!.tenantId!, userId: req.auth!.userId };
    const result = await serializable(prisma, async tx => {
      const purchase = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) }, include: { items: { include: { ingredient: { select: { name: true } } } }, supplier: true } });
      if (!purchase) return { status: 404, message: 'Purchase not found' } as const;
      if (purchase.status !== PurchaseStatus.DRAFT) return { status: 409, message: 'Purchase already received or cancelled' } as const;
      const itemIds = new Set(purchase.items.map(item => item.id));
      const overrides = new Map((body.data.lines ?? []).map(line => [line.itemId, line]));
      if ((body.data.lines ?? []).some(line => !itemIds.has(line.itemId)) || overrides.size !== (body.data.lines ?? []).length) return { status: 400, message: 'Receiving lines must match items of this purchase' } as const;
      if (body.data.invoiceId && !await tx.receivedInvoice.findFirst({ where: { id: body.data.invoiceId, tenantId }, select: { id: true } })) return { status: 400, message: 'Supplier invoice not found' } as const;
      const conference: ConferenceLine[] = [];
      let receivedTotal = new Prisma.Decimal(0);
      for (const item of purchase.items) {
        const line = overrides.get(item.id);
        const quantity = new Prisma.Decimal(line?.receivedQuantity ?? item.quantity.toNumber()).toDecimalPlaces(3);
        const cost = new Prisma.Decimal(line?.receivedUnitCost ?? item.unitCost.toNumber()).toDecimalPlaces(4);
        conference.push({ itemId: item.id, name: item.ingredient.name, orderedQuantity: item.quantity.toNumber(), receivedQuantity: quantity.toNumber(), orderedUnitCost: item.unitCost.toNumber(), receivedUnitCost: cost.toNumber() });
        receivedTotal = receivedTotal.add(quantity.mul(cost));
        await tx.purchaseItem.update({ where: { id: item.id }, data: { receivedQuantity: quantity, receivedUnitCost: cost } });
        if (quantity.isZero()) continue;
        const ingredient = await tx.ingredient.findFirst({ where: { id: item.ingredientId, tenantId } });
        if (!ingredient) return { status: 409, message: 'Purchase references an unavailable ingredient' } as const;
        const newStock = ingredient.currentStock.add(quantity);
        const averageCost = ingredient.currentStock.mul(ingredient.averageCost).add(quantity.mul(cost)).div(newStock).toDecimalPlaces(4);
        const incoming = line?.expiresAt ? new Date(`${line.expiresAt}T00:00:00Z`) : null;
        await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: newStock, averageCost, expiresAt: earliestExpiry(ingredient.expiresAt, incoming, ingredient.currentStock.gt(0)) } });
        await tx.stockMovement.create({ data: { tenantId, unitId: purchase.unitId ?? ingredient.unitId, ingredientId: ingredient.id, type: StockMovementType.PURCHASE, quantity, unitCost: cost, reference: purchase.id, note: `Purchase ${purchase.code}`, actorUserId: userId } });
      }
      const conferred = conferencePurchase(conference);
      const total = receivedTotal.toDecimalPlaces(2);
      const updated = await tx.purchaseOrder.update({ where: { id: purchase.id }, data: { status: PurchaseStatus.RECEIVED, receivedAt: new Date(), receivedTotal: total, receivedInvoiceId: body.data.invoiceId, receiptNote: body.data.note, receivedById: userId } });
      if (total.gt(0)) await tx.financialEntry.create({ data: { tenantId, unitId: purchase.unitId, description: `Compra ${purchase.code} - ${purchase.supplier.name}`, type: FinancialEntryType.EXPENSE, category: 'Compras', amount: total, dueAt: purchase.dueAt, status: FinancialEntryStatus.OPEN, reference: purchase.id } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: userId, action: 'PURCHASE_RECEIVED', entityType: 'PurchaseOrder', entityId: purchase.id, metadata: { orderedTotal: conferred.orderedTotal, receivedTotal: conferred.receivedTotal, divergences: conferred.divergences.length, invoiceId: body.data.invoiceId ?? null } } });
      return { status: 200, purchase: updated, conference: conferred } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json({ ...result.purchase, conference: result.conference });
  } catch (error) { return next(error); }
});

// Conference helper: pairs each ordered line with the best-matching line of an imported supplier XML so the operator can confirm quantities and prices.
purchasingRoutes.get('/orders/:id/conference', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const purchase = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) }, include: { items: { include: { ingredient: { select: { name: true, unitOfMeasure: true } } } }, supplier: { select: { name: true } } } });
    if (!purchase) return res.status(404).json({ message: 'Purchase not found' });
    const invoiceId = typeof req.query.invoiceId === 'string' ? req.query.invoiceId : purchase.receivedInvoiceId;
    const invoice = invoiceId ? await prisma.receivedInvoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, number: true, supplierName: true, totalAmount: true, items: true } }) : null;
    const invoiceItems = (Array.isArray(invoice?.items) ? invoice!.items as { description?: string; quantity?: number; unitValue?: number }[] : []).filter(item => typeof item.description === 'string') as { description: string; quantity?: number; unitValue?: number }[];
    const lines = purchase.items.map(item => {
      const match = invoiceItems.length ? matchInvoiceItem(item.ingredient.name, invoiceItems) : null;
      return { itemId: item.id, ingredient: item.ingredient.name, unitOfMeasure: item.ingredient.unitOfMeasure, orderedQuantity: item.quantity, orderedUnitCost: item.unitCost, receivedQuantity: item.receivedQuantity, receivedUnitCost: item.receivedUnitCost, invoiceMatch: match ? { description: match.item.description, quantity: match.item.quantity ?? null, unitValue: match.item.unitValue ?? null, score: match.score } : null };
    });
    const confirmed = purchase.status === PurchaseStatus.RECEIVED
      ? conferencePurchase(purchase.items.map(item => ({ itemId: item.id, name: item.ingredient.name, orderedQuantity: item.quantity.toNumber(), receivedQuantity: item.receivedQuantity?.toNumber() ?? null, orderedUnitCost: item.unitCost.toNumber(), receivedUnitCost: item.receivedUnitCost?.toNumber() ?? null })))
      : null;
    return res.json({ purchase: { id: purchase.id, code: purchase.code, status: purchase.status, supplier: purchase.supplier.name, total: purchase.total, receivedTotal: purchase.receivedTotal, receiptNote: purchase.receiptNote }, invoice: invoice ? { id: invoice.id, number: invoice.number, supplierName: invoice.supplierName, totalAmount: invoice.totalAmount } : null, lines, result: confirmed });
  } catch (error) { return next(error); }
});

// Price comparison between suppliers from real received purchases of an ingredient.
purchasingRoutes.get('/price-comparison', async (req, res, next) => {
  try {
    const ingredientId = z.string().uuid().safeParse(req.query.ingredientId);
    if (!ingredientId.success) return res.status(400).json({ message: 'ingredientId is required' });
    const tenantId = req.auth!.tenantId!;
    const ingredient = await prisma.ingredient.findFirst({ where: { id: ingredientId.data, tenantId }, select: { id: true, name: true, unitOfMeasure: true } });
    if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });
    const items = await prisma.purchaseItem.findMany({ where: { ingredientId: ingredient.id, purchase: { tenantId, status: PurchaseStatus.RECEIVED } }, orderBy: { purchase: { receivedAt: 'desc' } }, take: 500, select: { unitCost: true, receivedUnitCost: true, purchase: { select: { supplierId: true, receivedAt: true, supplier: { select: { name: true } } } } } });
    const points = items.map(item => ({ supplierId: item.purchase.supplierId, supplierName: item.purchase.supplier.name, unitCost: (item.receivedUnitCost ?? item.unitCost).toNumber(), at: item.purchase.receivedAt ?? new Date(0) }));
    return res.json({ ingredient, suppliers: comparePrices(points) });
  } catch (error) { return next(error); }
});
