import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma, StockMovementType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { serializable } from '../lib/serializable';
import { allowRead, MANAGEMENT_ROLES, PRODUCTION_ROLES, requireRoles } from '../lib/permissions';
import { earliestExpiry, expiryState, suggestPurchase } from '../lib/stock-planning';

export const inventoryRoutes = Router();
inventoryRoutes.use(requireAuth, requireTenant, allowRead(PRODUCTION_ROLES, MANAGEMENT_ROLES));
const expiryField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform(value => new Date(`${value}T00:00:00Z`)).refine(date => !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100, 'Invalid date');
const ingredientSchema = z.object({ name: z.string().min(2).max(150), unitOfMeasure: z.string().min(1).max(20), currentStock: z.number().nonnegative().default(0), minimumStock: z.number().nonnegative().optional(), maximumStock: z.number().nonnegative().optional(), category: z.string().trim().min(1).max(60).optional(), expiresAt: expiryField.optional(), averageCost: z.number().nonnegative().default(0), unitId: z.string().uuid().optional() })
  .refine(item => item.maximumStock === undefined || item.minimumStock === undefined || item.maximumStock >= item.minimumStock, { message: 'maximumStock must not be below minimumStock', path: ['maximumStock'] });
const WASTE_REASONS = ['EXPIRED', 'DAMAGED', 'PRODUCTION', 'OTHER'] as const;
const ingredientScope = (req: { auth?: { tenantId: string | null; unitId: string | null } }) => ({ tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) });
inventoryRoutes.get('/ingredients', async (req, res, next) => {
  try { const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }; const items = await prisma.ingredient.findMany({ where, orderBy: { name: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
inventoryRoutes.post('/ingredients', async (req, res, next) => {
  try { const parsed = ingredientSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() }); const unitId = parsed.data.unitId ?? req.auth!.unitId; if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Invalid unit for tenant' }); const item = await prisma.ingredient.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId!, unitId } }); return res.status(201).json(item); }
  catch (error) { return next(error); }
});
inventoryRoutes.patch('/ingredients/:id', async (req, res, next) => {
  try {
    const parsed = z.object({
      name: z.string().min(2).max(150), minimumStock: z.number().nonnegative().nullable(), maximumStock: z.number().nonnegative().nullable(), category: z.string().trim().min(1).max(60).nullable(),
      expiresAt: expiryField.nullable(), active: z.boolean(),
    }).partial().safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ message: 'Validation failed' });
    const current = await prisma.ingredient.findFirst({ where: { id: req.params.id, ...ingredientScope(req) } });
    if (!current) return res.status(404).json({ message: 'Ingredient not found' });
    const minimum = parsed.data.minimumStock === undefined ? current.minimumStock?.toNumber() ?? null : parsed.data.minimumStock;
    const maximum = parsed.data.maximumStock === undefined ? current.maximumStock?.toNumber() ?? null : parsed.data.maximumStock;
    if (minimum !== null && maximum !== null && maximum < minimum) return res.status(400).json({ message: 'maximumStock must not be below minimumStock' });
    const updated = await prisma.$transaction(async tx => {
      const saved = await tx.ingredient.update({ where: { id: current.id }, data: parsed.data });
      await tx.auditLog.create({ data: { tenantId: current.tenantId, actorUserId: req.auth!.userId, action: 'INGREDIENT_UPDATED', entityType: 'Ingredient', entityId: current.id, metadata: { before: { name: current.name, minimumStock: current.minimumStock?.toString() ?? null, maximumStock: current.maximumStock?.toString() ?? null, category: current.category, expiresAt: current.expiresAt, active: current.active }, changes: JSON.parse(JSON.stringify(parsed.data)) } } });
      return saved;
    });
    return res.json(updated);
  } catch (error) { return next(error); }
});
inventoryRoutes.post('/ingredients/:id/movements', async (req, res, next) => {
  try {
    const parsed = z.object({ type: z.enum(['PURCHASE', 'ADJUSTMENT', 'WASTE', 'TRANSFER_IN', 'TRANSFER_OUT']), quantity: z.number().positive(), unitCost: z.number().nonnegative().optional(), note: z.string().trim().max(500).optional(), reason: z.enum(WASTE_REASONS).optional(), expiresAt: expiryField.optional() })
      // Losses and manual adjustments must say why: the note is the justification kept with the responsible user.
      .refine(item => !['ADJUSTMENT', 'WASTE'].includes(item.type) || (item.note?.length ?? 0) >= 3, { message: 'A justification (note) is required for adjustments and losses', path: ['note'] }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const ingredient = await prisma.ingredient.findFirst({ where: { id: req.params.id, tenantId, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) } });
    if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });
    const increase = parsed.data.type === 'PURCHASE' || parsed.data.type === 'TRANSFER_IN'; const signed = new Prisma.Decimal(parsed.data.quantity).mul(increase ? 1 : -1);
    const result = await prisma.$transaction(async tx => {
      let updatedIngredient = await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: { increment: signed } } });
      if (updatedIngredient.currentStock.lt(0)) throw new Error('INSUFFICIENT_STOCK');
      // The recorded expiry follows the stock on the shelf: an incoming batch never postpones an older one, and an empty shelf has none.
      const expiry = updatedIngredient.currentStock.isZero() ? null : increase ? earliestExpiry(ingredient.expiresAt, parsed.data.expiresAt ?? null, ingredient.currentStock.gt(0)) : ingredient.expiresAt;
      if (expiry?.getTime() !== ingredient.expiresAt?.getTime()) updatedIngredient = await tx.ingredient.update({ where: { id: ingredient.id }, data: { expiresAt: expiry } });
      const reason = parsed.data.type === 'WASTE' ? parsed.data.reason ?? 'OTHER' : null;
      const movement = await tx.stockMovement.create({ data: { tenantId, unitId: ingredient.unitId ?? req.auth!.unitId, ingredientId: ingredient.id, type: parsed.data.type as StockMovementType, quantity: signed, unitCost: parsed.data.unitCost, note: parsed.data.note, reason, actorUserId: req.auth!.userId } });
      return { ingredient: updatedIngredient, movement };
    });
    return res.status(201).json(result);
  } catch (error) { if (error instanceof Error && error.message === 'INSUFFICIENT_STOCK') return res.status(409).json({ message: 'Movement would make stock negative' }); return next(error); }
});
inventoryRoutes.get('/movements', async (req, res, next) => {
  try { const items = await prisma.stockMovement.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { ingredient: true }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
inventoryRoutes.put('/recipes/:productId', async (req, res, next) => {
  try {
    const parsed = z.object({ yield: z.number().positive(), notes: z.string().max(1000).optional(), ingredients: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive() })).min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const product = await prisma.product.findFirst({ where: { id: req.params.productId, tenantId } }); if (!product) return res.status(404).json({ message: 'Product not found' });
    const ids = [...new Set(parsed.data.ingredients.map(x => x.ingredientId))]; const found = await prisma.ingredient.findMany({ where: { id: { in: ids }, tenantId } }); if (found.length !== ids.length) return res.status(400).json({ message: 'Recipe contains ingredient outside this tenant' });
    const recipe = await prisma.$transaction(async tx => { const saved = await tx.recipe.upsert({ where: { productId: product.id }, create: { tenantId, productId: product.id, yield: parsed.data.yield, notes: parsed.data.notes }, update: { yield: parsed.data.yield, notes: parsed.data.notes } }); await tx.recipeIngredient.deleteMany({ where: { recipeId: saved.id } }); await tx.recipeIngredient.createMany({ data: parsed.data.ingredients.map(x => ({ recipeId: saved.id, ingredientId: x.ingredientId, quantity: x.quantity })) }); return tx.recipe.findUnique({ where: { id: saved.id }, include: { ingredients: { include: { ingredient: true } } } }); });
    return res.json(recipe);
  } catch (error) { return next(error); }
});
inventoryRoutes.get('/recipes/:productId', async (req, res, next) => {
  try { const recipe = await prisma.recipe.findFirst({ where: { productId: req.params.productId, tenantId: req.auth!.tenantId! }, include: { ingredients: { include: { ingredient: true } }, product: true } }); if (!recipe) return res.status(404).json({ message: 'Recipe not found' }); return res.json(recipe); }
  catch (error) { return next(error); }
});

// Guided inventory: each counted line adjusts stock to the physical quantity and records the difference as an ADJUSTMENT movement.
inventoryRoutes.post('/counts', async (req, res, next) => {
  try {
    const parsed = z.object({ note: z.string().max(300).optional(), lines: z.array(z.object({ ingredientId: z.string().uuid(), countedQuantity: z.number().nonnegative().max(99999999999) })).min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const ids = parsed.data.lines.map(line => line.ingredientId); if (new Set(ids).size !== ids.length) return res.status(400).json({ message: 'Duplicate ingredient in count' });
    const tenantId = req.auth!.tenantId!;
    const result = await serializable(prisma, async tx => {
      const ingredients = await tx.ingredient.findMany({ where: { id: { in: ids }, tenantId, active: true, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) } });
      if (ingredients.length !== ids.length) return { status: 400 as const };
      const byId = new Map(ingredients.map(item => [item.id, item]));
      const adjustments = [];
      for (const line of parsed.data.lines) {
        const ingredient = byId.get(line.ingredientId)!; const counted = new Prisma.Decimal(line.countedQuantity).toDecimalPlaces(3); const difference = counted.sub(ingredient.currentStock);
        if (difference.isZero()) continue;
        await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: counted } });
        await tx.stockMovement.create({ data: { tenantId, unitId: ingredient.unitId ?? req.auth!.unitId, ingredientId: ingredient.id, type: StockMovementType.ADJUSTMENT, quantity: difference, note: parsed.data.note ?? 'Inventory count', actorUserId: req.auth!.userId } });
        adjustments.push({ ingredientId: ingredient.id, name: ingredient.name, previous: ingredient.currentStock, counted, difference });
      }
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'INVENTORY_COUNTED', entityType: 'Ingredient', metadata: { lines: parsed.data.lines.length, adjusted: adjustments.length } } });
      return { status: 200 as const, adjustments };
    });
    if (result.status !== 200) return res.status(400).json({ message: 'Ingredients unavailable in this tenant or unit' });
    return res.status(201).json({ adjustments: result.adjustments, adjusted: result.adjustments.length });
  } catch (error) { return next(error); }
});

// Moves stock between two ingredient records of the same tenant (e.g. one per unit); the destination cost is re-averaged.
inventoryRoutes.post('/transfers', async (req, res, next) => {
  try {
    const parsed = z.object({ fromIngredientId: z.string().uuid(), toIngredientId: z.string().uuid(), quantity: z.number().positive().max(99999999999), note: z.string().max(300).optional() }).safeParse(req.body);
    if (!parsed.success || parsed.data.fromIngredientId === parsed.data.toIngredientId) return res.status(400).json({ message: 'Validation failed' });
    const tenantId = req.auth!.tenantId!; const quantity = new Prisma.Decimal(parsed.data.quantity).toDecimalPlaces(3, Prisma.Decimal.ROUND_UP);
    if (req.auth!.unitId) return res.status(403).json({ message: 'Tenant-wide access is required to transfer between units' });
    const result = await serializable(prisma, async tx => {
      const [from, to] = await Promise.all([tx.ingredient.findFirst({ where: { id: parsed.data.fromIngredientId, tenantId, active: true } }), tx.ingredient.findFirst({ where: { id: parsed.data.toIngredientId, tenantId, active: true } })]);
      if (!from || !to) return { status: 404, message: 'Ingredient not found' } as const;
      if (from.unitOfMeasure !== to.unitOfMeasure) return { status: 400, message: 'Ingredients must use the same unit of measure' } as const;
      if (from.currentStock.lt(quantity)) return { status: 409, message: 'Insufficient stock to transfer' } as const;
      const newToStock = to.currentStock.add(quantity);
      const averageCost = to.currentStock.mul(to.averageCost).add(quantity.mul(from.averageCost)).div(newToStock).toDecimalPlaces(4);
      await tx.ingredient.update({ where: { id: from.id }, data: { currentStock: { decrement: quantity } } });
      await tx.ingredient.update({ where: { id: to.id }, data: { currentStock: newToStock, averageCost } });
      const reference = randomUUID(); const note = parsed.data.note ?? 'Stock transfer';
      await tx.stockMovement.create({ data: { tenantId, unitId: from.unitId, ingredientId: from.id, type: StockMovementType.TRANSFER_OUT, quantity: quantity.negated(), unitCost: from.averageCost, reference, note, actorUserId: req.auth!.userId } });
      await tx.stockMovement.create({ data: { tenantId, unitId: to.unitId, ingredientId: to.id, type: StockMovementType.TRANSFER_IN, quantity, unitCost: from.averageCost, reference, note, actorUserId: req.auth!.userId } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'STOCK_TRANSFERRED', entityType: 'Ingredient', entityId: from.id, metadata: { to: to.id, quantity: quantity.toString(), reference } } });
      return { status: 201, reference } as const;
    });
    if (result.status !== 201) return res.status(result.status).json({ message: result.message });
    return res.status(201).json({ reference: result.reference });
  } catch (error) { return next(error); }
});

// ---------- Guided inventory sessions (full, partial or by category) with history ----------
const countScopeSchema = z.object({
  title: z.string().trim().min(3).max(120), scope: z.enum(['FULL', 'PARTIAL', 'CATEGORY']), category: z.string().trim().min(1).max(60).optional(),
  ingredientIds: z.array(z.string().uuid()).max(500).optional(), note: z.string().trim().max(300).optional(),
});
inventoryRoutes.post('/count-sessions', async (req, res, next) => {
  try {
    const parsed = countScopeSchema.safeParse(req.body);
    if (!parsed.success || (parsed.data.scope === 'CATEGORY' && !parsed.data.category) || (parsed.data.scope === 'PARTIAL' && !parsed.data.ingredientIds?.length)) return res.status(400).json({ message: 'Validation failed' });
    const tenantId = req.auth!.tenantId!; const unitId = req.auth!.unitId;
    const where = { ...ingredientScope(req), active: true, ...(parsed.data.scope === 'CATEGORY' ? { category: parsed.data.category } : {}), ...(parsed.data.scope === 'PARTIAL' ? { id: { in: parsed.data.ingredientIds } } : {}) };
    const created = await serializable(prisma, async tx => {
      if (await tx.inventoryCount.findFirst({ where: { tenantId, unitId, status: 'OPEN' }, select: { id: true } })) return { status: 409 as const };
      const ingredients = await tx.ingredient.findMany({ where, orderBy: { name: 'asc' }, take: 1000 });
      if (ingredients.length === 0 || (parsed.data.scope === 'PARTIAL' && ingredients.length !== new Set(parsed.data.ingredientIds).size)) return { status: 400 as const };
      const session = await tx.inventoryCount.create({
        data: { tenantId, unitId, title: parsed.data.title, scope: parsed.data.scope, category: parsed.data.category, note: parsed.data.note, startedById: req.auth!.userId,
          lines: { create: ingredients.map(item => ({ ingredientId: item.id, name: item.name, unitOfMeasure: item.unitOfMeasure, expected: item.currentStock, unitCost: item.averageCost })) } },
        include: { lines: true },
      });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'INVENTORY_SESSION_OPENED', entityType: 'InventoryCount', entityId: session.id, metadata: { scope: parsed.data.scope, lines: ingredients.length } } });
      return { status: 201 as const, session };
    });
    if (created.status === 409) return res.status(409).json({ message: 'There is already an open inventory for this unit. Close or cancel it first.' });
    if (created.status === 400) return res.status(400).json({ message: 'No ingredient matches this inventory scope' });
    return res.status(201).json(created.session);
  } catch (error) { return next(error); }
});
inventoryRoutes.get('/count-sessions', async (req, res, next) => {
  try {
    const items = await prisma.inventoryCount.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { lines: { select: { counted: true, adjustment: true, unitCost: true } } } });
    return res.json({ items: items.map(({ lines, ...session }) => ({ ...session, lineCount: lines.length, countedCount: lines.filter(line => line.counted !== null).length, adjustedCount: lines.filter(line => line.adjustment && !line.adjustment.isZero()).length, adjustmentValue: lines.reduce((sum, line) => sum.add((line.adjustment ?? new Prisma.Decimal(0)).mul(line.unitCost)), new Prisma.Decimal(0)).toDecimalPlaces(2) })) });
  } catch (error) { return next(error); }
});
inventoryRoutes.get('/count-sessions/:id', async (req, res, next) => {
  try {
    const session = await prisma.inventoryCount.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { lines: { orderBy: { name: 'asc' } } } });
    return session ? res.json(session) : res.status(404).json({ message: 'Inventory not found' });
  } catch (error) { return next(error); }
});
inventoryRoutes.put('/count-sessions/:id/lines', async (req, res, next) => {
  try {
    const parsed = z.object({ lines: z.array(z.object({ ingredientId: z.string().uuid(), counted: z.number().nonnegative().max(99999999999).nullable(), note: z.string().trim().max(200).optional() })).min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const session = await prisma.inventoryCount.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, select: { id: true, status: true } });
    if (!session) return res.status(404).json({ message: 'Inventory not found' });
    if (session.status !== 'OPEN') return res.status(409).json({ message: 'This inventory is closed' });
    const saved = await prisma.$transaction(async tx => {
      let count = 0;
      for (const line of parsed.data.lines) {
        const updated = await tx.inventoryCountLine.updateMany({ where: { countId: session.id, ingredientId: line.ingredientId }, data: { counted: line.counted === null ? null : new Prisma.Decimal(line.counted).toDecimalPlaces(3), note: line.note } });
        count += updated.count;
      }
      return count;
    });
    return res.json({ saved });
  } catch (error) { return next(error); }
});
// Closing applies one ADJUSTMENT per counted line against the stock at that moment (sales during the count are preserved), then locks the session.
inventoryRoutes.post('/count-sessions/:id/close', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const result = await serializable(prisma, async tx => {
      const session = await tx.inventoryCount.findFirst({ where: { id: req.params.id, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { lines: true } });
      if (!session) return { status: 404 as const };
      if (session.status !== 'OPEN') return { status: 409 as const };
      const counted = session.lines.filter(line => line.counted !== null);
      if (counted.length === 0) return { status: 400 as const };
      let adjusted = 0; let value = new Prisma.Decimal(0);
      for (const line of counted) {
        const ingredient = await tx.ingredient.findFirst({ where: { id: line.ingredientId, tenantId } });
        if (!ingredient) continue;
        const difference = line.counted!.sub(ingredient.currentStock);
        await tx.inventoryCountLine.update({ where: { id: line.id }, data: { adjustment: difference } });
        if (difference.isZero()) continue;
        await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: line.counted!, ...(line.counted!.isZero() ? { expiresAt: null } : {}) } });
        await tx.stockMovement.create({ data: { tenantId, unitId: ingredient.unitId ?? session.unitId, ingredientId: ingredient.id, type: StockMovementType.ADJUSTMENT, quantity: difference, unitCost: ingredient.averageCost, reference: session.id, note: `Inventário: ${session.title}`, actorUserId: req.auth!.userId } });
        adjusted += 1; value = value.add(difference.mul(ingredient.averageCost));
      }
      await tx.inventoryCount.update({ where: { id: session.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: req.auth!.userId } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'INVENTORY_SESSION_CLOSED', entityType: 'InventoryCount', entityId: session.id, metadata: { counted: counted.length, uncounted: session.lines.length - counted.length, adjusted, value: value.toFixed(2) } } });
      return { status: 200 as const, counted: counted.length, uncounted: session.lines.length - counted.length, adjusted, adjustmentValue: value.toDecimalPlaces(2) };
    });
    if (result.status === 404) return res.status(404).json({ message: 'Inventory not found' });
    if (result.status === 409) return res.status(409).json({ message: 'This inventory is already closed' });
    if (result.status === 400) return res.status(400).json({ message: 'Count at least one item before closing' });
    return res.json(result);
  } catch (error) { return next(error); }
});
inventoryRoutes.post('/count-sessions/:id/cancel', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const updated = await prisma.inventoryCount.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: 'OPEN' }, data: { status: 'CANCELLED', closedAt: new Date(), closedById: req.auth!.userId } });
    return updated.count === 1 ? res.status(204).end() : res.status(409).json({ message: 'Only an open inventory can be cancelled' });
  } catch (error) { return next(error); }
});

// ---------- Planning: purchase suggestions from real consumption, expiry and cost history ----------
inventoryRoutes.get('/suggestions', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!; const now = new Date(); const since = new Date(now.getTime() - 30 * 86_400_000);
    const [ingredients, moves, lastItems] = await Promise.all([
      prisma.ingredient.findMany({ where: { ...ingredientScope(req), active: true }, orderBy: { name: 'asc' }, take: 1000 }),
      prisma.stockMovement.groupBy({ by: ['ingredientId', 'type'], where: { tenantId, createdAt: { gte: since }, type: { in: ['ORDER_CONSUMPTION', 'ORDER_REVERSAL'] } }, _sum: { quantity: true } }),
      prisma.purchaseItem.findMany({ where: { purchase: { tenantId, status: 'RECEIVED' } }, orderBy: { purchase: { receivedAt: 'desc' } }, take: 2000, select: { ingredientId: true, purchase: { select: { supplierId: true, supplier: { select: { name: true } } } } } }),
    ]);
    const consumed = new Map<string, number>();
    for (const row of moves) consumed.set(row.ingredientId, (consumed.get(row.ingredientId) ?? 0) - Number(row._sum.quantity ?? 0));
    const lastSupplier = new Map<string, { id: string; name: string }>();
    for (const item of lastItems) if (!lastSupplier.has(item.ingredientId)) lastSupplier.set(item.ingredientId, { id: item.purchase.supplierId, name: item.purchase.supplier.name });
    const items = ingredients.flatMap(ingredient => {
      const suggestion = suggestPurchase({ current: ingredient.currentStock.toNumber(), minimum: ingredient.minimumStock?.toNumber() ?? null, maximum: ingredient.maximumStock?.toNumber() ?? null, consumed30: Math.max(0, consumed.get(ingredient.id) ?? 0) });
      if (suggestion.quantity <= 0) return [];
      const supplier = lastSupplier.get(ingredient.id) ?? null;
      return [{ ingredientId: ingredient.id, name: ingredient.name, unitOfMeasure: ingredient.unitOfMeasure, current: ingredient.currentStock.toNumber(), minimum: ingredient.minimumStock?.toNumber() ?? null, maximum: ingredient.maximumStock?.toNumber() ?? null, ...suggestion, unitCost: ingredient.averageCost.toNumber(), estimatedCost: Math.round(suggestion.quantity * ingredient.averageCost.toNumber() * 100) / 100, supplier }];
    });
    return res.json({ generatedAt: now, windowDays: 30, items, estimatedTotal: Math.round(items.reduce((sum, item) => sum + item.estimatedCost, 0) * 100) / 100, note: 'Sugestões usam o estoque atual, o mínimo/máximo cadastrado e o consumo real dos últimos 30 dias; sem consumo registrado só vale o mínimo.' });
  } catch (error) { return next(error); }
});
inventoryRoutes.get('/expiring', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7)); const now = new Date();
    const items = await prisma.ingredient.findMany({ where: { ...ingredientScope(req), active: true, currentStock: { gt: 0 }, expiresAt: { not: null, lte: new Date(now.getTime() + days * 86_400_000) } }, orderBy: { expiresAt: 'asc' }, take: 200, select: { id: true, name: true, unitOfMeasure: true, currentStock: true, averageCost: true, expiresAt: true } });
    return res.json({ days, items: items.map(item => ({ ...item, state: expiryState(item.expiresAt, now, days), valueAtRisk: item.currentStock.mul(item.averageCost).toDecimalPlaces(2) })) });
  } catch (error) { return next(error); }
});
inventoryRoutes.get('/ingredients/:id/cost-history', async (req, res, next) => {
  try {
    const ingredient = await prisma.ingredient.findFirst({ where: { id: req.params.id, ...ingredientScope(req) }, select: { id: true, name: true, averageCost: true } });
    if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });
    const rows = await prisma.stockMovement.findMany({ where: { tenantId: req.auth!.tenantId!, ingredientId: ingredient.id, unitCost: { not: null }, type: { in: ['PURCHASE', 'TRANSFER_IN'] } }, orderBy: { createdAt: 'desc' }, take: 100, select: { createdAt: true, type: true, unitCost: true, quantity: true, note: true } });
    return res.json({ ingredient, currentAverageCost: ingredient.averageCost, history: rows });
  } catch (error) { return next(error); }
});

