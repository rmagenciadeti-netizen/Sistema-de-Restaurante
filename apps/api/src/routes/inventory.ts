import { Router } from 'express';
import { Prisma, StockMovementType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const inventoryRoutes = Router();
inventoryRoutes.use(requireAuth, requireTenant);
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
