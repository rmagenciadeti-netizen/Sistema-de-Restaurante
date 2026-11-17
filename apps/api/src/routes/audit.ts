import { Router } from 'express';
import { z } from 'zod';
import { MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const auditRoutes = Router();
auditRoutes.use(requireAuth, requireTenant, requireRoles(...MANAGEMENT_ROLES));

auditRoutes.get('/', async (req, res, next) => {
  try {
    if (req.auth!.unitId) return res.status(403).json({ message: 'Tenant-wide administrator access required' });
    const query = z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
      action: z.string().trim().min(1).max(100).optional(),
      entityType: z.string().trim().min(1).max(100).optional(),
      actorUserId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters or pagination' });
    const { page, pageSize, action, entityType, actorUserId, from, to } = query.data;
    if (from && to && new Date(from) > new Date(to)) return res.status(400).json({ message: 'Invalid date range' });
    const where = {
      tenantId: req.auth!.tenantId!,
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        select: {
          id: true, actorUserId: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true,
          actor: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
