import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { ALL_TENANT_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, saveSettingsSection, SETTINGS_SECTIONS, SettingsSectionName } from '../lib/settings';
import { settingsSectionIssues } from '../lib/settings-checks';
import { parseImageDataUrl, toDataUrl } from '../lib/product-image';

export const settingsRoutes = Router();
settingsRoutes.use(requireAuth, requireTenant);

const isSection = (name: string): name is SettingsSectionName => Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, name);

settingsRoutes.get('/', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const [settings, row] = await Promise.all([loadSettings(prisma, tenantId), prisma.tenantSettings.findUnique({ where: { tenantId }, select: { adminPasswordHash: true, orderCounter: true } })]);
    const images = await prisma.storeImage.findMany({ where: { tenantId }, select: { kind: true, updatedAt: true } });
    return res.json({ settings, hasAdminPassword: Boolean(row?.adminPasswordHash), orderCounter: row?.orderCounter ?? 0, storeImages: Object.fromEntries(images.map(image => [image.kind, image.updatedAt.getTime()])) });
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

// Store profile pictures (logo and cover) shown on the public virtual store.
const imageKind = z.enum(['LOGO', 'COVER']);
settingsRoutes.get('/store-image/:kind', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const kind = imageKind.safeParse(req.params.kind); if (!kind.success) return res.status(404).json({ message: 'Imagem não encontrada.' });
    const image = await prisma.storeImage.findUnique({ where: { tenantId_kind: { tenantId: req.auth!.tenantId!, kind: kind.data } } }); if (!image) return res.status(404).json({ message: 'Imagem não encontrada.' });
    return res.json({ dataUrl: toDataUrl(image.contentType, image.data) });
  } catch (error) { return next(error); }
});
settingsRoutes.put('/store-image/:kind', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const kind = imageKind.safeParse(req.params.kind); if (!kind.success) return res.status(404).json({ message: 'Imagem não encontrada.' });
    const body = z.object({ dataUrl: z.string().max(450_000) }).safeParse(req.body); if (!body.success) return res.status(400).json({ message: 'Validation failed' });
    const image = parseImageDataUrl(body.data.dataUrl); if ('error' in image) return res.status(400).json({ message: image.error });
    const tenantId = req.auth!.tenantId!;
    const saved = await prisma.storeImage.upsert({ where: { tenantId_kind: { tenantId, kind: kind.data } }, create: { tenantId, kind: kind.data, ...image }, update: { ...image }, select: { updatedAt: true } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'STORE_IMAGE_SET', entityType: 'StoreImage', entityId: kind.data, metadata: { bytes: image.data.length } } });
    return res.json({ kind: kind.data, version: saved.updatedAt.getTime() });
  } catch (error) { return next(error); }
});
settingsRoutes.delete('/store-image/:kind', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const kind = imageKind.safeParse(req.params.kind); if (!kind.success) return res.status(404).json({ message: 'Imagem não encontrada.' });
    const tenantId = req.auth!.tenantId!;
    await prisma.storeImage.deleteMany({ where: { tenantId, kind: kind.data } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'STORE_IMAGE_REMOVED', entityType: 'StoreImage', entityId: kind.data } });
    return res.json({ kind: kind.data, removed: true });
  } catch (error) { return next(error); }
});
// Sets the last issued order number: the next order gets current + 1. Numbers are display labels only (the order code stays unique), so lowering it is allowed.
settingsRoutes.put('/order-counter', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ current: z.number().int().min(0).max(999_999) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Informe um número inteiro entre 0 e 999999.' });
    const tenantId = req.auth!.tenantId!;
    const row = await prisma.tenantSettings.upsert({ where: { tenantId }, create: { tenantId, orderCounter: parsed.data.current, orderCounterDate: new Date() }, update: { orderCounter: parsed.data.current, orderCounterDate: new Date() }, select: { orderCounter: true } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'ORDER_COUNTER_SET', entityType: 'TenantSettings', entityId: tenantId, metadata: { current: row.orderCounter } } });
    return res.json({ orderCounter: row.orderCounter });
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
