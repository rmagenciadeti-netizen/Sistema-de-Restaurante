import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { requireRoles, MANAGEMENT_ROLES } from '../lib/permissions';
import { ADJUST_MODES, ROUNDINGS, SKIP_MESSAGES, adjustProduct, type AdjustInput } from '../lib/bulk-adjust';

export const productToolsRoutes = Router();
productToolsRoutes.use(requireAuth, requireTenant, requireRoles(...MANAGEMENT_ROLES));

const MAX_PRODUCTS = 1000;
const fieldSchema = z.object({ mode: z.enum(ADJUST_MODES), value: z.number().finite().min(0).max(1_000_000) });
const bulkSchema = z.object({
  selection: z.object({
    productIds: z.array(z.string().uuid()).max(MAX_PRODUCTS).optional(),
    categoryId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    active: z.boolean().optional(),
    q: z.string().trim().max(100).optional(),
  }),
  price: fieldSchema.nullable().optional(),
  cost: fieldSchema.nullable().optional(),
  rounding: z.enum(ROUNDINGS).default('NONE'),
}).superRefine((value, ctx) => {
  if (!value.price && !value.cost) ctx.addIssue({ code: 'custom', message: 'Informe uma alteração de preço ou de custo.', path: ['price'] });
  if (value.cost?.mode === 'COST_MARGIN') ctx.addIssue({ code: 'custom', message: 'Margem sobre custo só se aplica ao preço.', path: ['cost'] });
  for (const [key, field] of [['price', value.price], ['cost', value.cost]] as const) {
    if (field?.mode === 'DECREASE_PERCENT' && field.value > 100) ctx.addIssue({ code: 'custom', message: 'Percentual de redução acima de 100%.', path: [key] });
  }
});

type Selection = z.infer<typeof bulkSchema>['selection'];

async function selectProducts(db: Pick<Prisma.TransactionClient, 'product'>, tenantId: string, unitId: string | null, selection: Selection) {
  const filters: Prisma.ProductWhereInput[] = [];
  if (unitId) filters.push({ OR: [{ unitId }, { unitId: null }] });
  if (selection.q) filters.push({ OR: [{ name: { contains: selection.q, mode: 'insensitive' } }, { code: { contains: selection.q, mode: 'insensitive' } }, { barcode: { contains: selection.q } }] });
  const where: Prisma.ProductWhereInput = {
    tenantId, AND: filters,
    ...(selection.productIds ? { id: { in: selection.productIds } } : {}),
    ...(selection.categoryId ? { categoryId: selection.categoryId === 'none' ? null : selection.categoryId } : {}),
    ...(selection.active !== undefined ? { active: selection.active } : {}),
  };
  return db.product.findMany({ where, select: { id: true, name: true, price: true, cost: true, active: true, category: { select: { name: true } } }, orderBy: { name: 'asc' }, take: MAX_PRODUCTS + 1 });
}

const plan = (products: Awaited<ReturnType<typeof selectProducts>>, input: AdjustInput) => products.map(product => ({ product, result: adjustProduct(product, input) }));
const money = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed(2));
const tooMany = `A seleção tem mais de ${MAX_PRODUCTS} produtos. Refine os filtros.`;

productToolsRoutes.post('/bulk-adjust/preview', async (req, res, next) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const { tenantId, unitId } = req.auth!;
    const products = await selectProducts(prisma, tenantId!, unitId, parsed.data.selection);
    if (products.length > MAX_PRODUCTS) return res.status(400).json({ message: tooMany });
    const items = plan(products, parsed.data).map(({ product, result }) => ({
      id: product.id, name: product.name, category: product.category?.name ?? null, active: product.active,
      priceBefore: money(product.price), costBefore: money(product.cost),
      priceAfter: result.skipped ? null : money(result.price), costAfter: result.skipped ? null : money(result.cost),
      skipped: result.skipped, skipCode: result.skipped ? result.code : null, reason: result.skipped ? SKIP_MESSAGES[result.code] : null,
    }));
    const changed = items.filter(item => !item.skipped).length;
    return res.json({ items, total: items.length, changed, skipped: items.length - changed });
  } catch (error) { return next(error); }
});

productToolsRoutes.post('/bulk-adjust/apply', async (req, res, next) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const { tenantId, unitId, userId } = req.auth!;
    const outcome = await serializable(prisma, async tx => {
      const products = await selectProducts(tx, tenantId!, unitId, parsed.data.selection);
      if (products.length > MAX_PRODUCTS) return null;
      const planned = plan(products, parsed.data);
      let updated = 0;
      const sample: { id: string; price: string; newPrice: string }[] = [];
      for (const { product, result } of planned) {
        if (result.skipped) continue;
        await tx.product.update({ where: { id: product.id }, data: { price: result.price, ...(parsed.data.cost ? { cost: result.cost } : {}) } });
        updated += 1;
        if (sample.length < 20) sample.push({ id: product.id, price: product.price.toFixed(2), newPrice: result.price.toFixed(2) });
      }
      const skipped = planned.length - updated;
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PRODUCT_BULK_ADJUST', entityType: 'Product', metadata: { selected: planned.length, updated, skipped, price: parsed.data.price ?? null, cost: parsed.data.cost ?? null, rounding: parsed.data.rounding, sample } } });
      return { selected: planned.length, updated, skipped };
    });
    if (!outcome) return res.status(400).json({ message: tooMany });
    return res.json(outcome);
  } catch (error) { return next(error); }
});
