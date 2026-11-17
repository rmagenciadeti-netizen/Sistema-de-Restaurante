import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, saveSettingsSection, SETTINGS_SECTIONS, SettingsSectionName } from '../lib/settings';
import { settingsSectionIssues } from '../lib/settings-checks';

export const settingsRoutes = Router();
settingsRoutes.use(requireAuth, requireTenant);

const isSection = (name: string): name is SettingsSectionName => Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, name);

settingsRoutes.get('/', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const [settings, row] = await Promise.all([loadSettings(prisma, tenantId), prisma.tenantSettings.findUnique({ where: { tenantId }, select: { adminPasswordHash: true } })]);
    return res.json({ settings, hasAdminPassword: Boolean(row?.adminPasswordHash) });
  } catch (error) { return next(error); }
});

settingsRoutes.post('/admin-password', requireRoles(UserRole.ADMIN), async (req, res, next) => {
  try {
    const parsed = z.object({ password: z.string().min(4).max(60).nullable() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const adminPasswordHash = parsed.data.password === null ? null : await bcrypt.hash(parsed.data.password, 12);
    await prisma.$transaction(async tx => {
      await tx.tenantSettings.upsert({ where: { tenantId }, create: { tenantId, adminPasswordHash }, update: { adminPasswordHash } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: adminPasswordHash ? 'ADMIN_PASSWORD_SET' : 'ADMIN_PASSWORD_REMOVED', entityType: 'TenantSettings', entityId: tenantId } });
    });
    return res.json({ hasAdminPassword: adminPasswordHash !== null });
  } catch (error) { return next(error); }
});

settingsRoutes.put('/:section', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const section = req.params.section;
    if (!isSection(section)) return res.status(404).json({ message: 'Settings section not found' });
    const parsed = SETTINGS_SECTIONS[section].safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const issues = settingsSectionIssues(section, parsed.data);
    if (issues.length > 0) return res.status(400).json({ message: 'Validation failed', errors: { formErrors: issues, fieldErrors: {} } });
    const tenantId = req.auth!.tenantId!;
    const value = await prisma.$transaction(async tx => {
      const saved = await saveSettingsSection(tx, tenantId, section, parsed.data);
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'SETTINGS_UPDATED', entityType: 'TenantSettings', entityId: tenantId, metadata: { section } } });
      return saved;
    });
    return res.json({ section, value });
  } catch (error) { return next(error); }
});
