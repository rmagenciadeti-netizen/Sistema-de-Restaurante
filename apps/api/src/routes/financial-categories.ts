import { Router } from 'express';
import { FinancialEntryType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { activeFilter, audit, isUniqueViolation, listQuerySchema, validationError } from '../lib/registry';

// INCOME = contas a receber, EXPENSE = contas a pagar. FinancialEntry.category keeps the category name as text.
export const financialCategoryRoutes = Router();
financialCategoryRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

const schema = z.object({ type: z.nativeEnum(FinancialEntryType), name: z.string().trim().min(2).max(100), active: z.boolean().default(true) });
const conflict = { message: 'Já existe uma categoria com esse nome neste tipo.' };

financialCategoryRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.extend({ type: z.nativeEnum(FinancialEntryType).optional() }).safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active, type } = query.data;
    const items = await prisma.financialCategory.findMany({ where: { tenantId: req.auth!.tenantId!, ...activeFilter(active), ...(type ? { type } : {}), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }, orderBy: [{ type: 'asc' }, { name: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

financialCategoryRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    if (await prisma.financialCategory.findFirst({ where: { tenantId, type: parsed.data.type, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const created = await prisma.financialCategory.create({ data: { ...parsed.data, tenantId } });
    await audit(req, 'FINANCIAL_CATEGORY_CREATED', 'FinancialCategory', created.id, { type: created.type });
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

// The type cannot change after creation because existing entries are of that type. Renaming also updates the entries that use the name.
financialCategoryRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.pick({ name: true, active: true }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.financialCategory.findFirst({ where: { id: req.params.id, tenantId } }); if (!current) return res.status(404).json({ message: 'Categoria não encontrada.' });
    if (parsed.data.name && await prisma.financialCategory.findFirst({ where: { tenantId, type: current.type, id: { not: current.id }, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const updated = await prisma.$transaction(async tx => {
      const saved = await tx.financialCategory.update({ where: { id: current.id }, data: parsed.data });
      if (parsed.data.name && parsed.data.name !== current.name) await tx.financialEntry.updateMany({ where: { tenantId, type: current.type, category: current.name }, data: { category: parsed.data.name } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'FINANCIAL_CATEGORY_ACTIVATED' : 'FINANCIAL_CATEGORY_DEACTIVATED') : 'FINANCIAL_CATEGORY_UPDATED', entityType: 'FinancialCategory', entityId: current.id } });
      return saved;
    });
    return res.json(updated);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

// Categories already used by entries are deactivated instead of deleted.
financialCategoryRoutes.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.financialCategory.findFirst({ where: { id: req.params.id, tenantId } }); if (!current) return res.status(404).json({ message: 'Categoria não encontrada.' });
    if (await prisma.financialEntry.count({ where: { tenantId, type: current.type, category: current.name } }) > 0) {
      const updated = await prisma.financialCategory.update({ where: { id: current.id }, data: { active: false } });
      await audit(req, 'FINANCIAL_CATEGORY_DEACTIVATED', 'FinancialCategory', current.id);
      return res.json({ deleted: false, deactivated: true, category: updated });
    }
    await prisma.financialCategory.delete({ where: { id: current.id } });
    await audit(req, 'FINANCIAL_CATEGORY_DELETED', 'FinancialCategory', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
