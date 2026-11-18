import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { resolveAppearance } from '../lib/appearance';
import { appearancePreferenceSchema, loadSettings } from '../lib/settings';

// Visual preferences: the restaurant default is saved through PUT /settings/appearance; here each user reads the effective theme and manages a personal one.
export const appearanceRoutes = Router();
appearanceRoutes.use(requireAuth);

async function snapshot(userId: string, tenantId: string | null | undefined) {
  const [user, settings] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { appearance: true } }), tenantId ? loadSettings(prisma, tenantId) : null]);
  const tenant = settings?.appearance ?? null;
  const personal = appearancePreferenceSchema.safeParse(user?.appearance);
  return { tenant, user: personal.success ? personal.data : null, effective: resolveAppearance(tenant, user?.appearance) };
}

appearanceRoutes.get('/', async (req, res, next) => {
  try { return res.json(await snapshot(req.auth!.userId, req.auth!.tenantId)); } catch (error) { return next(error); }
});

appearanceRoutes.put('/me', async (req, res, next) => {
  try {
    const parsed = appearancePreferenceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, userId } = req.auth!;
    if (tenantId && !(await loadSettings(prisma, tenantId)).appearance.allowUserOverride) return res.status(403).json({ message: 'O restaurante desativou a personalização individual.' });
    await prisma.user.update({ where: { id: userId }, data: { appearance: parsed.data } });
    return res.json(await snapshot(userId, tenantId));
  } catch (error) { return next(error); }
});

appearanceRoutes.delete('/me', async (req, res, next) => {
  try {
    await prisma.user.update({ where: { id: req.auth!.userId }, data: { appearance: Prisma.DbNull } });
    return res.json(await snapshot(req.auth!.userId, req.auth!.tenantId));
  } catch (error) { return next(error); }
});
