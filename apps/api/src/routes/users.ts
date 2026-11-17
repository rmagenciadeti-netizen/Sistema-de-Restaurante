import { Router } from 'express';
import { UserRole, UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';

export const userRoutes = Router();
userRoutes.use(requireAuth, requireTenant, requireRoles(...MANAGEMENT_ROLES));

const STAFF_ROLES = Object.values(UserRole).filter(role => role !== UserRole.MASTER_ADMIN);
const publicFields = { id: true, name: true, email: true, role: true, status: true, unitId: true, commissionPercent: true, createdAt: true } as const;
// Only an ADMIN may create or change privileged accounts; a MANAGER handles operational staff.
const PRIVILEGED: UserRole[] = [UserRole.ADMIN, UserRole.MANAGER];
const canGrant = (actor: UserRole, role: UserRole) => actor === UserRole.ADMIN || !PRIVILEGED.includes(role);

const createSchema = z.object({
  name: z.string().min(2).max(160),
  email: z.string().email().transform(value => value.toLowerCase()),
  password: z.string().min(10).max(200),
  role: z.enum(STAFF_ROLES as [UserRole, ...UserRole[]]),
  unitId: z.string().uuid().nullable().optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
});

userRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.user.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, select: publicFields, orderBy: { name: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
userRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (!canGrant(req.auth!.role, parsed.data.role)) return res.status(403).json({ message: 'Only administrators can grant this role' });
    const unitId = parsed.data.unitId === undefined ? req.auth!.unitId : parsed.data.unitId;
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } })) return res.status(409).json({ message: 'E-mail já cadastrado' });
    const { password, ...data } = parsed.data;
    const user = await prisma.user.create({ data: { ...data, unitId, tenantId, passwordHash: await bcrypt.hash(password, 12) }, select: publicFields });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'USER_CREATED', entityType: 'User', entityId: user.id, metadata: { role: user.role } } });
    return res.status(201).json(user);
  } catch (error) { return next(error); }
});
userRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().min(2).max(160), role: z.enum(STAFF_ROLES as [UserRole, ...UserRole[]]), status: z.nativeEnum(UserStatus), unitId: z.string().uuid().nullable(), commissionPercent: z.number().min(0).max(100), password: z.string().min(10).max(200) }).partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.user.findFirst({ where: { id: req.params.id, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!current) return res.status(404).json({ message: 'User not found' });
    if (current.id === req.auth!.userId && (parsed.data.role || parsed.data.status || parsed.data.unitId !== undefined)) return res.status(409).json({ message: 'You cannot change your own role, status or unit' });
    if (!canGrant(req.auth!.role, current.role) || (parsed.data.role && !canGrant(req.auth!.role, parsed.data.role))) return res.status(403).json({ message: 'Only administrators can change this account' });
    if (parsed.data.unitId) {
      if (req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
      if (!await prisma.unit.findFirst({ where: { id: parsed.data.unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    }
    const { password, ...data } = parsed.data;
    const user = await prisma.user.update({ where: { id: current.id }, data: { ...data, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) }, select: publicFields });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'USER_UPDATED', entityType: 'User', entityId: user.id, metadata: { fields: Object.keys(parsed.data).filter(key => key !== 'password'), passwordReset: Boolean(password) } } });
    return res.json(user);
  } catch (error) { return next(error); }
});
