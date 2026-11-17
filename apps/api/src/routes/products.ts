import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, MANAGEMENT_ROLES, allowRead } from '../lib/permissions';
import { parseImageDataUrl, toDataUrl } from '../lib/product-image';

export const productRoutes = Router();
productRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));
const schema = z.object({ name: z.string().min(2).max(160), categoryId: z.string().uuid().optional().nullable(), sectorId: z.string().uuid().optional().nullable(), unitId: z.string().uuid().optional().nullable(), code: z.string().max(50).optional().nullable(), description: z.string().max(2000).optional().nullable(), price: z.number().nonnegative(), cost: z.number().nonnegative().optional().nullable(), active: z.boolean().default(true), prepTimeMinutes: z.number().int().nonnegative().optional().nullable(),
  barcode: z.string().trim().max(40).optional().nullable(), favorite: z.boolean().optional(), soldByWeight: z.boolean().optional(), sendToScale: z.boolean().optional(),
  scaleCode: z.number().int().min(1).max(9999999).optional().nullable(), scaleDepartment: z.number().int().min(0).max(99).optional().nullable(), shelfLifeDays: z.number().int().min(0).max(999).optional().nullable(),
  scaleNotes: z.string().trim().max(500).optional().nullable(), ncm: z.string().regex(/^\d{8}$/, 'NCM deve ter 8 dígitos').optional().nullable(), cest: z.string().regex(/^\d{7}$/, 'CEST deve ter 7 dígitos').optional().nullable(),
  taxRuleId: z.string().uuid().optional().nullable(),
  gtin: z.string().regex(/^(\d{8}|\d{12}|\d{13}|\d{14})$/, 'GTIN deve ter 8, 12, 13 ou 14 dígitos').optional().nullable(),
  measureUnit: z.enum(['UN', 'KG', 'G', 'L', 'ML', 'CX', 'PCT', 'PORC']).optional(), localOnly: z.boolean().optional(), isComponent: z.boolean().optional() });
const priceText = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const bulkPricesSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), expectedPrice: priceText, price: priceText })).min(1).max(100),
}).refine(value => new Set(value.items.map(item => item.id.toLowerCase())).size === value.items.length, 'Duplicate product');
const emptyToNull = <T extends { barcode?: string | null; scaleNotes?: string | null }>(data: T): T => ({ ...data, ...(data.barcode !== undefined ? { barcode: data.barcode || null } : {}), ...(data.scaleNotes !== undefined ? { scaleNotes: data.scaleNotes || null } : {}) });
const duplicateMessage = (error: unknown) => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const target = Array.isArray(error.meta?.target) ? error.meta.target.join(',') : String(error.meta?.target ?? '');
  return target.includes('scaleCode') ? 'Já existe um produto com esse código de balança.' : 'Já existe um produto com esse código.';
};
async function validateCatalogFields(tenantId: string, data: { sendToScale?: boolean; scaleCode?: number | null; taxRuleId?: string | null }, current?: { sendToScale: boolean; scaleCode: number | null }) {
  if ((data.sendToScale ?? current?.sendToScale) && (data.scaleCode === undefined ? current?.scaleCode : data.scaleCode) == null) return 'Informe o código da balança para enviar o produto à balança.';
  if (data.taxRuleId && !await prisma.taxRule.findFirst({ where: { id: data.taxRuleId, tenantId } })) return 'A regra tributária não pertence a este restaurante.';
  return null;
}
const categorySchema = z.object({ name: z.string().trim().min(2).max(100) });
productRoutes.get('/categories', async (req, res, next) => {
  try {
    const items = await prisma.productCategory.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { name: 'asc' } });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
productRoutes.post('/categories', async (req, res, next) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Informe um nome de categoria válido.' });
  try {
    const item = await prisma.productCategory.create({ data: { tenantId: req.auth!.tenantId!, name: parsed.data.name } });
    return res.status(201).json(item);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe uma categoria com esse nome.' });
    return next(error);
  }
});
productRoutes.patch('/categories/:id', async (req, res, next) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Informe um nome de categoria válido.' });
  try {
    const result = await prisma.productCategory.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, data: { name: parsed.data.name } });
    if (!result.count) return res.status(404).json({ message: 'Categoria não encontrada.' });
    return res.json({ updated: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe uma categoria com esse nome.' });
    return next(error);
  }
});
productRoutes.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) };
    const [items, total] = await Promise.all([prisma.product.findMany({ where, include: { category: true, sector: true, image: { select: { updatedAt: true } } }, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.product.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
productRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { unitId, categoryId, sectorId, ...rawData } = parsed.data; const data = emptyToNull(rawData); const effectiveUnitId = unitId ?? req.auth!.unitId;
    if (effectiveUnitId && !await prisma.unit.findFirst({ where: { id: effectiveUnitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (categoryId && !await prisma.productCategory.findFirst({ where: { id: categoryId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Category does not belong to this tenant' });
    if (sectorId && !await prisma.productionSector.findFirst({ where: { id: sectorId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Production sector does not belong to this tenant' });
    const invalid = await validateCatalogFields(req.auth!.tenantId!, data); if (invalid) return res.status(400).json({ message: invalid });
    const item = await prisma.product.create({ data: { ...data, tenantId: req.auth!.tenantId!, unitId: effectiveUnitId, categoryId, sectorId } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_CREATED', entityType: 'Product', entityId: item.id } });
    return res.status(201).json(item);
  } catch (error) { const message = duplicateMessage(error); return message ? res.status(409).json({ message }) : next(error); }
});
productRoutes.patch('/prices/bulk', async (req, res, next) => {
  const parsed = bulkPricesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const { tenantId, unitId, userId } = req.auth!;
    await prisma.$transaction(async tx => {
      for (const item of [...parsed.data.items].sort((a, b) => a.id.localeCompare(b.id))) {
        const result = await tx.product.updateMany({
          where: { id: item.id, tenantId: tenantId!, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}), price: item.expectedPrice },
          data: { price: item.price },
        });
        if (result.count !== 1) throw new PriceConflictError();
        await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PRODUCT_PRICE_UPDATED', entityType: 'Product', entityId: item.id, metadata: { previousPrice: item.expectedPrice, price: item.price } } });
      }
    });
    return res.json({ updated: parsed.data.items.length });
  } catch (error) {
    if (error instanceof PriceConflictError) return res.status(409).json({ message: 'Um produto foi alterado ou não está disponível. Atualize a lista e revise os preços.' });
    return next(error);
  }
});
const productScope = (req: Request, id: string) => ({ id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) });
productRoutes.get('/:id/image', async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({ where: productScope(req, req.params.id), select: { image: true } }); if (!product) return res.status(404).json({ message: 'Product not found' });
    if (!product.image) return res.status(404).json({ message: 'O produto não tem foto.' });
    return res.json({ dataUrl: toDataUrl(product.image.contentType, product.image.data) });
  } catch (error) { return next(error); }
});
productRoutes.put('/:id/image', async (req, res, next) => {
  try {
    const parsed = z.object({ dataUrl: z.string().max(450_000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const image = parseImageDataUrl(parsed.data.dataUrl); if ('error' in image) return res.status(400).json({ message: image.error });
    const product = await prisma.product.findFirst({ where: productScope(req, req.params.id), select: { id: true } }); if (!product) return res.status(404).json({ message: 'Product not found' });
    await prisma.productImage.upsert({ where: { productId: product.id }, create: { productId: product.id, ...image }, update: { ...image } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_IMAGE_SET', entityType: 'Product', entityId: product.id, metadata: { bytes: image.data.length } } });
    return res.json({ productId: product.id, bytes: image.data.length });
  } catch (error) { return next(error); }
});
productRoutes.delete('/:id/image', async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({ where: productScope(req, req.params.id), select: { id: true } }); if (!product) return res.status(404).json({ message: 'Product not found' });
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_IMAGE_REMOVED', entityType: 'Product', entityId: product.id } });
    return res.json({ productId: product.id, removed: true });
  } catch (error) { return next(error); }
});
productRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const where = { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) };
    const current = await prisma.product.findFirst({ where }); if (!current) return res.status(404).json({ message: 'Product not found' });
    const unitId = parsed.data.unitId === undefined ? current.unitId : (parsed.data.unitId ?? req.auth!.unitId);
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (parsed.data.categoryId && !await prisma.productCategory.findFirst({ where: { id: parsed.data.categoryId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Category does not belong to this tenant' });
    if (parsed.data.sectorId && !await prisma.productionSector.findFirst({ where: { id: parsed.data.sectorId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Production sector does not belong to this tenant' });
    const invalid = await validateCatalogFields(req.auth!.tenantId!, parsed.data, current); if (invalid) return res.status(400).json({ message: invalid });
    const { unitId: _unitId, ...rawData } = parsed.data; const data = emptyToNull(rawData); const updated = await prisma.product.update({ where: { id: current.id }, data: { ...data, ...(parsed.data.unitId !== undefined ? { unitId } : {}) } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_UPDATED', entityType: 'Product', entityId: updated.id } });
    return res.json(updated);
  } catch (error) { const message = duplicateMessage(error); return message ? res.status(409).json({ message }) : next(error); }
});

class PriceConflictError extends Error {}
