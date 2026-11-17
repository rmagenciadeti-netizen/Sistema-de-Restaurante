import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { createAttemptLimiter } from '../lib/attempt-limiter';

export const RELEASE_ACTIONS = ['CANCEL_ORDER', 'DISCOUNT', 'CASH_WITHDRAWAL', 'CLOSE_CASH', 'OTHER'] as const;

export const releaseRoutes = Router();
releaseRoutes.use(requireAuth, requireTenant);
const limiter = createAttemptLimiter(5, 15 * 60 * 1000);

const authorizeSchema = z.object({ action: z.enum(RELEASE_ACTIONS), password: z.string().min(1).max(60), reason: z.string().trim().max(300).optional(), orderId: z.string().uuid().optional() });
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});

releaseRoutes.post('/', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const parsed = authorizeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, userId, unitId } = { tenantId: req.auth!.tenantId!, userId: req.auth!.userId, unitId: req.auth!.unitId };
    const wait = limiter.blockedFor(userId);
    if (wait > 0) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ message: 'Too many failed attempts. Try again later.' }); }
    if (parsed.data.orderId && !await prisma.order.findFirst({ where: { id: parsed.data.orderId, tenantId, ...unitScope(req) }, select: { id: true } })) return res.status(404).json({ message: 'Order not found' });
    const row = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { adminPasswordHash: true } });
    if (!row?.adminPasswordHash) return res.status(409).json({ message: 'No administrator password configured' });
    if (!await bcrypt.compare(parsed.data.password, row.adminPasswordHash)) {
      limiter.fail(userId);
      await prisma.auditLog.create({ data: { tenantId, actorUserId: userId, action: 'PASSWORD_RELEASE_DENIED', entityType: 'PasswordRelease', metadata: { action: parsed.data.action, orderId: parsed.data.orderId ?? null } } });
      return res.status(403).json({ message: 'Invalid password' });
    }
    limiter.reset(userId);
    const release = await prisma.$transaction(async tx => {
      const created = await tx.passwordRelease.create({ data: { tenantId, unitId, action: parsed.data.action, orderId: parsed.data.orderId, requestedByUserId: userId, reason: parsed.data.reason || null } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: userId, action: 'PASSWORD_RELEASE_AUTHORIZED', entityType: 'PasswordRelease', entityId: created.id, metadata: { action: created.action, orderId: created.orderId, reason: created.reason } } });
      return created;
    });
    return res.json({ id: release.id, authorizedAt: release.createdAt });
  } catch (error) { return next(error); }
});

const listSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(), to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional() });

releaseRoutes.get('/', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { page, pageSize, from, to } = parsed.data;
    const tenantId = req.auth!.tenantId!;
    const dateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    const createdAt = {
      ...(from ? { gte: new Date(dateOnly(from) ? `${from}T00:00:00.000Z` : from) } : {}),
      ...(to ? { lt: dateOnly(to) ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000) : new Date(to) } : {}),
    };
    const where = { tenantId, ...unitScope(req), ...(from || to ? { createdAt } : {}) };
    const [rows, total] = await Promise.all([
      prisma.passwordRelease.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.passwordRelease.count({ where }),
    ]);
    const userIds = [...new Set(rows.map(row => row.requestedByUserId))];
    const orderIds = [...new Set(rows.flatMap(row => (row.orderId ? [row.orderId] : [])))];
    const [users, orders] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds }, tenantId }, select: { id: true, name: true } }),
      prisma.order.findMany({ where: { id: { in: orderIds }, tenantId }, select: { id: true, code: true, number: true } }),
    ]);
    const userName = new Map(users.map(user => [user.id, user.name]));
    const orderById = new Map(orders.map(order => [order.id, order]));
    const items = rows.map(row => ({ ...row, requestedByName: userName.get(row.requestedByUserId) ?? null, orderCode: row.orderId ? orderById.get(row.orderId)?.code ?? null : null, orderNumber: row.orderId ? orderById.get(row.orderId)?.number ?? null : null }));
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
