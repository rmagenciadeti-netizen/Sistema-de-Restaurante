import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { AUTOMATION_RULES, FINANCIAL_RULE_KEYS, runAutomations } from '../lib/automations';

// In-app notifications created by the automations center (lib/automations.ts). Financial notifications are only readable by roles that
// may open the Financial module, so a waiter never sees revenue figures through the bell.
export const notificationRoutes = Router();
notificationRoutes.use(requireAuth, requireTenant);

function visibleWhere(req: { auth?: { tenantId: string | null; role: string } }) {
  const finance = FINANCE_ROLES.some(role => role === req.auth!.role);
  return { tenantId: req.auth!.tenantId!, ...(finance ? {} : { ruleKey: { notIn: FINANCIAL_RULE_KEYS } }) };
}

notificationRoutes.get('/', async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === '1';
    const where = { ...visibleWhere(req), ...(unreadOnly ? { readAt: null } : {}) };
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, ruleKey: true, severity: true, title: true, body: true, href: true, readAt: true, createdAt: true } }),
      prisma.notification.count({ where: { ...visibleWhere(req), readAt: null } }),
    ]);
    return res.json({ items, unread });
  } catch (error) { return next(error); }
});

notificationRoutes.post('/read-all', async (req, res, next) => {
  try {
    const result = await prisma.notification.updateMany({ where: { ...visibleWhere(req), readAt: null }, data: { readAt: new Date() } });
    return res.json({ updated: result.count });
  } catch (error) { return next(error); }
});

notificationRoutes.post('/:id/read', async (req, res, next) => {
  try {
    const result = await prisma.notification.updateMany({ where: { ...visibleWhere(req), id: req.params.id, readAt: null }, data: { readAt: new Date() } });
    return result.count === 1 ? res.status(204).end() : res.status(404).json({ message: 'Notification not found' });
  } catch (error) { return next(error); }
});

notificationRoutes.get('/rules', requireRoles(...MANAGEMENT_ROLES), (_req, res) => res.json({ items: AUTOMATION_RULES.map(({ key, label, financial }) => ({ key, label, financial })) }));

// Runs the rules now for the caller's company; the daily/period dedupe key keeps repeated clicks from creating duplicates.
notificationRoutes.post('/run', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    z.object({}).parse(req.body ?? {});
    return res.json(await runAutomations(prisma, req.auth!.tenantId!));
  } catch (error) { return next(error); }
});
