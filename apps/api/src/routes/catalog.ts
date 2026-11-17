import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, allowRead, MANAGEMENT_ROLES } from '../lib/permissions';
import { moneySchema } from '../lib/money';

export const catalogRoutes = Router();
catalogRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const optionSchema = z.object({ name: z.string().min(1).max(100), price: moneySchema.default(0), sectorId: z.string().uuid().nullable().optional() });
const groupSchema = z.object({ name: z.string().min(2).max(100), minSelect: z.number().int().min(0).max(50).default(0), maxSelect: z.number().int().min(1).max(50).default(1), options: z.array(optionSchema).min(1).max(100) })
  .refine(group => group.minSelect <= group.maxSelect, { message: 'minSelect cannot exceed maxSelect', path: ['minSelect'] });

async function sectorsBelongToTenant(tenantId: string, sectorIds: Array<string | null | undefined>) {
  const ids = [...new Set(sectorIds.filter((id): id is string => Boolean(id)))];
  return ids.length === 0 || await prisma.productionSector.count({ where: { id: { in: ids }, tenantId } }) === ids.length;
}

catalogRoutes.get('/modifier-groups', async (req, res, next) => {
  try { const items = await prisma.modifierGroup.findMany({ where: { tenantId: req.auth!.tenantId! }, include: { options: { orderBy: { name: 'asc' } }, products: { select: { productId: true } } }, orderBy: { name: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
catalogRoutes.post('/modifier-groups', async (req, res, next) => {
  try {
    const parsed = groupSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (!await sectorsBelongToTenant(tenantId, parsed.data.options.map(option => option.sectorId))) return res.status(400).json({ message: 'Sector does not belong to this tenant' });
    if (new Set(parsed.data.options.map(option => option.name)).size !== parsed.data.options.length) return res.status(400).json({ message: 'Duplicate option names' });
    if (await prisma.modifierGroup.findUnique({ where: { tenantId_name: { tenantId, name: parsed.data.name } } })) return res.status(409).json({ message: 'Group already exists' });
    const { options, ...group } = parsed.data;
    return res.status(201).json(await prisma.modifierGroup.create({ data: { ...group, tenantId, options: { create: options.map(option => ({ ...option, sectorId: option.sectorId ?? null })) } }, include: { options: true } }));
  } catch (error) { return next(error); }
});
catalogRoutes.patch('/modifier-groups/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().min(2).max(100), minSelect: z.number().int().min(0).max(50), maxSelect: z.number().int().min(1).max(50), active: z.boolean() }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Group not found' });
    if ((parsed.data.minSelect ?? current.minSelect) > (parsed.data.maxSelect ?? current.maxSelect)) return res.status(400).json({ message: 'minSelect cannot exceed maxSelect' });
    return res.json(await prisma.modifierGroup.update({ where: { id: current.id }, data: parsed.data, include: { options: true } }));
  } catch (error) { return next(error); }
});
catalogRoutes.post('/modifier-groups/:id/options', async (req, res, next) => {
  try {
    const parsed = optionSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const group = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, tenantId } }); if (!group) return res.status(404).json({ message: 'Group not found' });
    if (!await sectorsBelongToTenant(tenantId, [parsed.data.sectorId])) return res.status(400).json({ message: 'Sector does not belong to this tenant' });
    if (await prisma.modifierOption.findUnique({ where: { groupId_name: { groupId: group.id, name: parsed.data.name } } })) return res.status(409).json({ message: 'Option already exists' });
    return res.status(201).json(await prisma.modifierOption.create({ data: { ...parsed.data, sectorId: parsed.data.sectorId ?? null, groupId: group.id } }));
  } catch (error) { return next(error); }
});
catalogRoutes.patch('/modifier-options/:id', async (req, res, next) => {
  try {
    const parsed = optionSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.modifierOption.findFirst({ where: { id: req.params.id, group: { tenantId } } }); if (!current) return res.status(404).json({ message: 'Option not found' });
    if (!await sectorsBelongToTenant(tenantId, [parsed.data.sectorId])) return res.status(400).json({ message: 'Sector does not belong to this tenant' });
    return res.json(await prisma.modifierOption.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});

catalogRoutes.put('/products/:id/modifier-groups', async (req, res, next) => {
  try {
    const parsed = z.object({ groupIds: z.array(z.string().uuid()).max(30) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const groupIds = [...new Set(parsed.data.groupIds)];
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } }); if (!product) return res.status(404).json({ message: 'Product not found' });
    if (await prisma.modifierGroup.count({ where: { id: { in: groupIds }, tenantId } }) !== groupIds.length) return res.status(400).json({ message: 'Group does not belong to this tenant' });
    await prisma.$transaction([prisma.productModifierGroup.deleteMany({ where: { productId: product.id } }), prisma.productModifierGroup.createMany({ data: groupIds.map(groupId => ({ productId: product.id, groupId })) })]);
    return res.json({ productId: product.id, groupIds });
  } catch (error) { return next(error); }
});

// Combos are billed as one line; each component is produced and printed by its own sector.
catalogRoutes.put('/products/:id/combo', async (req, res, next) => {
  try {
    const parsed = z.object({ components: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(50).default(1) })).max(30) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const components = parsed.data.components;
    const combo = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } }); if (!combo) return res.status(404).json({ message: 'Product not found' });
    const ids = components.map(component => component.productId);
    if (new Set(ids).size !== ids.length || ids.includes(combo.id)) return res.status(400).json({ message: 'Invalid components' });
    if (ids.length > 0 && await prisma.product.count({ where: { id: { in: ids }, tenantId, isCombo: false } }) !== ids.length) return res.status(400).json({ message: 'Components must be non-combo products of this tenant' });
    if (ids.length > 0 && await prisma.comboComponent.count({ where: { productId: combo.id } }) > 0) return res.status(409).json({ message: 'A product used as a combo component cannot become a combo' });
    await prisma.$transaction([
      prisma.comboComponent.deleteMany({ where: { comboId: combo.id } }),
      prisma.comboComponent.createMany({ data: components.map(component => ({ comboId: combo.id, productId: component.productId, quantity: component.quantity })) }),
      prisma.product.update({ where: { id: combo.id }, data: { isCombo: components.length > 0 } }),
    ]);
    return res.json({ productId: combo.id, isCombo: components.length > 0, components });
  } catch (error) { return next(error); }
});
catalogRoutes.get('/products/:id/composition', async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, select: { id: true, name: true, isCombo: true, comboComponents: { select: { quantity: true, product: { select: { id: true, name: true } } } }, modifierGroups: { select: { groupId: true } } } });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.json(product);
  } catch (error) { return next(error); }
});
