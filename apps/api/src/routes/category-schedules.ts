import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';

export const categoryScheduleRoutes = Router();
categoryScheduleRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const windowSchema = z.object({ weekday: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440) })
  .refine(window => window.startMinute < window.endMinute, 'startMinute must be before endMinute');
const putSchema = z.object({ windows: z.array(windowSchema).max(100) });

categoryScheduleRoutes.get('/', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const [categories, rows] = await Promise.all([
      prisma.productCategory.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.categorySchedule.findMany({ where: { tenantId }, select: { categoryId: true, weekday: true, startMinute: true, endMinute: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
    ]);
    const items = categories.map(category => ({ categoryId: category.id, categoryName: category.name, windows: rows.filter(row => row.categoryId === category.id).map(({ categoryId: _categoryId, ...window }) => window) }));
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

categoryScheduleRoutes.put('/:categoryId', async (req, res, next) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  if (!z.string().uuid().safeParse(req.params.categoryId).success) return res.status(404).json({ message: 'Categoria não encontrada.' });
  try {
    const { tenantId, userId } = req.auth!;
    const categoryId = req.params.categoryId;
    const result = await serializable(prisma, async tx => {
      const category = await tx.productCategory.findFirst({ where: { id: categoryId, tenantId: tenantId! }, select: { id: true, name: true } });
      if (!category) return null;
      await tx.categorySchedule.deleteMany({ where: { tenantId: tenantId!, categoryId } });
      if (parsed.data.windows.length) await tx.categorySchedule.createMany({ data: parsed.data.windows.map(window => ({ ...window, tenantId: tenantId!, categoryId })) });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'CATEGORY_SCHEDULE_UPDATED', entityType: 'ProductCategory', entityId: categoryId, metadata: { windows: parsed.data.windows.length } } });
      return category;
    });
    if (!result) return res.status(404).json({ message: 'Categoria não encontrada.' });
    return res.json({ categoryId, categoryName: result.name, windows: [...parsed.data.windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute) });
  } catch (error) { return next(error); }
});
