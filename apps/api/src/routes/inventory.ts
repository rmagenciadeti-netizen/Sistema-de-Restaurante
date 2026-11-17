import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma, StockMovementType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { serializable } from '../lib/serializable';
import { allowRead, MANAGEMENT_ROLES, PRODUCTION_ROLES } from '../lib/permissions';

export const inventoryRoutes = Router();
inventoryRoutes.use(requireAuth, requireTenant, allowRead(PRODUCTION_ROLES, MANAGEMENT_ROLES));
const ingredientSchema = z.object({ name: z.string().min(2).max(150), unitOfMeasure: z.string().min(1).max(20), currentStock: z.number().nonnegative().default(0), minimumStock: z.number().nonnegative().optional(), averageCost: z.number().nonnegative().default(0), unitId: z.string().uuid().optional() });
inventoryRoutes.get('/ingredients', async (req, res, next) => {
  try { const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }; const items = await prisma.ingredient.findMany({ where, orderBy: { name: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
inventoryRoutes.post('/ingredients', async (req, res, next) => {
  try { const parsed = ingredientSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() }); const unitId = parsed.data.unitId ?? req.auth!.unitId; if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Invalid unit for tenant' }); const item = await prisma.ingredient.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId!, unitId } }); return res.status(201).json(item); }
  catch (error) { return next(error); }
});
inventoryRoutes.post('/ingredients/:id/movements', async (req, res, next) => {
  try {
    const parsed = z.object({ type: z.enum(['PURCHASE', 'ADJUSTMENT', 'WASTE', 'TRANSFER_IN', 'TRANSFER_OUT']), quantity: z.number().positive(), unitCost: z.number().nonnegative().optional(), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const ingredient = await prisma.ingredient.findFirst({ where: { id: req.params.id, tenantId, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) } });
    if (!ingredient) return res.status(404).json({ message: 'Ingredient not found' });
    const increase = parsed.data.type === 'PURCHASE' || parsed.data.type === 'TRANSFER_IN'; const signed = new Prisma.Decimal(parsed.data.quantity).mul(increase ? 1 : -1);
    const result = await prisma.$transaction(async tx => {
      const updatedIngredient = await tx.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: { increment: signed } } });
      if (updatedIngredient.currentStock.lt(0)) throw new Error('INSUFFICIENT_STOCK');
      const movement = await tx.stockMovement.create({ data: { tenantId, unitId: ingredient.unitId ?? req.auth!.unitId, ingredientId: ingredient.id, type: parsed.data.type as StockMovementType, quantity: signed, unitCost: parsed.data.unitCost, note: parsed.data.note, actorUserId: req.auth!.userId } });
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

