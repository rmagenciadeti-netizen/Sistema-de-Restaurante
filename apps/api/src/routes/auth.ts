import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { signAccessToken, requireAuth } from '../middleware/auth';

export const authRoutes = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many login attempts. Try again later.' } });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
authRoutes.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const input = loginSchema.safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Invalid credentials format' });
    const user = await prisma.user.findUnique({ where: { email: input.data.email.toLowerCase() }, include: { tenant: true } });
    if (!user || !user.passwordHash || user.status !== 'ACTIVE' || !(await bcrypt.compare(input.data.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect' });
    if (user.role !== 'MASTER_ADMIN' && (!user.tenant || !['ACTIVE', 'TRIAL'].includes(user.tenant.status))) return res.status(403).json({ message: 'Tenant is not available' });
    const accessToken = signAccessToken({ userId: user.id, tenantId: user.tenantId, unitId: user.unitId, role: user.role });
    return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 28800, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId, unitId: user.unitId } });
  } catch (error) { return next(error); }
});
authRoutes.get('/me', requireAuth, async (req, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, name: true, email: true, role: true, tenantId: true, unitId: true } }); return res.json({ user }); }
  catch (error) { return next(error); }
});
