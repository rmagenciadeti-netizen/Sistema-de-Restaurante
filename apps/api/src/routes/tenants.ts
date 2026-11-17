import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { BillingPeriod, Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';
import { MODULE_CATALOG, MODULE_KEYS } from '../lib/licensing';

export const tenantRoutes = Router();
tenantRoutes.use(requireAuth, requireMaster);
const createSchema = z.object({ name: z.string().min(2).max(160), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), plan: z.enum(['BASIC', 'PRO', 'PREMIUM', 'ENTERPRISE']).default('BASIC'), commercialPlanId: z.string().uuid().optional(), adminName: z.string().min(2).max(160), adminEmail: z.string().email().transform(value => value.toLowerCase()), adminPassword: z.string().min(12).max(200), unitName: z.string().min(2).max(100).default('Matriz') });
const publicProvisioning = (job: { id: string; tenantId: string; status: string; step: string; attempts: number; lastError: string | null; completedSteps: string[]; startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date }) => ({
  id: job.id, tenantId: job.tenantId, status: job.status, step: job.step, attempts: job.attempts,
  lastError: job.lastError, completedSteps: job.completedSteps, startedAt: job.startedAt,
  completedAt: job.completedAt, createdAt: job.createdAt, updatedAt: job.updatedAt,
});
tenantRoutes.get('/', async (_req, res, next) => {
  try { const items = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { units: true, users: true } } } }); return res.json({ total: items.length, items }); }
  catch (error) { return next(error); }
});
tenantRoutes.get('/stats/summary', async (_req, res, next) => {
  try {
    const [total, active, trial, suspended] = await Promise.all([prisma.tenant.count(), prisma.tenant.count({ where: { status: 'ACTIVE' } }), prisma.tenant.count({ where: { status: 'TRIAL' } }), prisma.tenant.count({ where: { status: { in: ['SUSPENDED', 'BLOCKED'] } } })]);
    return res.json({ total, active, trial, suspended });
  } catch (error) { return next(error); }
});
tenantRoutes.get('/provisioning', async (_req, res, next) => {
  try {
    const items = await prisma.tenantProvisioning.findMany({
      include: { tenant: { select: { id: true, name: true, slug: true, status: true, license: { select: { status: true } }, _count: { select: { units: true, users: true } } } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const [waiting, processing, errors, intervention] = await Promise.all([
      prisma.tenantProvisioning.count({ where: { status: 'WAITING' } }),
      prisma.tenantProvisioning.count({ where: { status: 'PROCESSING' } }),
      prisma.tenantProvisioning.count({ where: { status: 'ERROR' } }),
      prisma.tenantProvisioning.count({ where: { status: 'NEEDS_INTERVENTION' } }),
    ]);
    return res.json({ items: items.map(item => ({ ...publicProvisioning(item), tenant: item.tenant })), counts: { waiting, processing, errors, intervention } });
  } catch (error) { return next(error); }
});
tenantRoutes.post('/', async (req, res, next) => {
  let requestKey: string | undefined;
  let requestHash: string | undefined;
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    requestKey = req.header('Idempotency-Key');
    if (requestKey && !/^[a-zA-Z0-9._:-]{8,128}$/.test(requestKey)) return res.status(400).json({ message: 'Invalid Idempotency-Key' });
    if (requestKey) {
      const idempotencySecret = process.env.IDEMPOTENCY_SECRET ?? process.env.JWT_SECRET;
      if (!idempotencySecret) return next(new Error('IDEMPOTENCY_SECRET or JWT_SECRET must be configured for idempotent provisioning'));
      requestHash = createHmac('sha256', idempotencySecret).update(JSON.stringify(parsed.data)).digest('hex');
    }
    if (requestKey) {
      const previous = await prisma.tenantProvisioning.findUnique({ where: { idempotencyKey: requestKey }, include: { tenant: { include: { units: { take: 1, orderBy: { createdAt: 'asc' } }, users: { where: { role: 'ADMIN' }, take: 1, select: { id: true, name: true, email: true } } } } } });
      if (previous) {
        if (previous.requestHash !== requestHash) return res.status(409).json({ message: 'Idempotency-Key already used for a different request' });
        return res.status(200).json({ tenant: previous.tenant, unit: previous.tenant.units[0] ?? null, admin: previous.tenant.users[0] ?? null, provisioning: publicProvisioning(previous) });
      }
    }
    const { name, slug, plan, commercialPlanId, adminName, adminEmail, adminPassword, unitName } = parsed.data;
    if (await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } })) return res.status(409).json({ message: 'E-mail já cadastrado' });
    const commercialPlan = commercialPlanId ? await prisma.saaSPlan.findFirst({ where: { id: commercialPlanId, active: true }, include: { modules: true, prices: true } }) : null;
    if (commercialPlanId && !commercialPlan) return res.status(400).json({ message: 'Plano comercial inexistente ou inativo' });
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const created = await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({ data: { name, slug, plan, status: 'TRIAL' } });
      const unit = await tx.unit.create({ data: { tenantId: tenant.id, name: unitName, code: 'MATRIZ' } });
      const user = await tx.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: adminName, email: adminEmail, passwordHash, role: 'ADMIN' } });
      if (commercialPlan) {
        const price = commercialPlan.prices.find(item => item.period === BillingPeriod.MONTHLY) ?? commercialPlan.prices[0];
        await tx.tenantLicense.create({ data: {
          tenantId: tenant.id, planId: commercialPlan.id, status: 'PENDING', maxUnits: commercialPlan.maxUnits, maxUsers: commercialPlan.maxUsers,
          billingPeriod: price?.period ?? null, contractedPrice: price?.amount ?? null,
          activationFee: commercialPlan.activationFee, setupFee: commercialPlan.setupFee, discountPercent: 0,
        } });
        await tx.tenantModule.createMany({ data: commercialPlan.modules.map(item => ({ tenantId: tenant.id, moduleKey: item.moduleKey })), skipDuplicates: true });
      }
      const completedSteps = ['REQUEST_RECEIVED', 'TENANT_CREATED', 'COMPANY_CREATED', 'OWNER_CREATED', 'ADMIN_CREATED', 'PERMISSIONS_READY', ...(commercialPlan ? ['LICENSE_CREATED', 'MODULES_PREPARED'] : []), 'ENVIRONMENT_READY'];
      const provisioning = await tx.tenantProvisioning.create({ data: {
        tenantId: tenant.id, status: 'COMPLETED', step: 'ENVIRONMENT_READY', attempts: 1, completedSteps, startedAt: new Date(), completedAt: new Date(),
        ...(requestKey ? { idempotencyKey: requestKey, requestHash } : {}),
      } });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_CREATED', entityType: 'Tenant', entityId: tenant.id } });
      return { tenant, unit, admin: { id: user.id, name: user.name, email: user.email }, provisioning: publicProvisioning(provisioning) };
    });
    return res.status(201).json(created);
  } catch (error) {
    if (requestKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const previous = await prisma.tenantProvisioning.findUnique({ where: { idempotencyKey: requestKey }, include: { tenant: { include: { units: { take: 1, orderBy: { createdAt: 'asc' } }, users: { where: { role: 'ADMIN' }, take: 1, select: { id: true, name: true, email: true } } } } } });
      if (previous && previous.requestHash === requestHash) return res.status(200).json({ tenant: previous.tenant, unit: previous.tenant.units[0] ?? null, admin: previous.tenant.users[0] ?? null, provisioning: publicProvisioning(previous) });
      if (previous) return res.status(409).json({ message: 'Idempotency-Key already used for a different request' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Empresa, e-mail ou identificador já cadastrado' });
    return next(error);
  }
});
tenantRoutes.post('/:id/provision/retry', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, units: { take: 1, orderBy: { createdAt: 'asc' }, select: { id: true } }, users: { where: { role: 'ADMIN', status: 'ACTIVE' }, take: 1, select: { id: true } } } });
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    await prisma.tenantProvisioning.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, status: 'PROCESSING', step: 'RETRY_REQUESTED', attempts: 1, startedAt: new Date() },
      update: { status: 'PROCESSING', step: 'RETRY_REQUESTED', attempts: { increment: 1 }, lastError: null, startedAt: new Date(), completedAt: null },
    });
    const result = await prisma.$transaction(async tx => {
      let unit = await tx.unit.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } });
      if (!unit) unit = await tx.unit.create({ data: { tenantId: tenant.id, name: 'Matriz', code: 'MATRIZ' } });
      const admin = await tx.user.findFirst({ where: { tenantId: tenant.id, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
      const missingAdmin = !admin;
      const status = missingAdmin ? 'NEEDS_INTERVENTION' : 'COMPLETED';
      const completedSteps = ['TENANT_VERIFIED', 'COMPANY_CREATED', ...(admin ? ['ADMIN_VERIFIED', 'ENVIRONMENT_READY'] : [])];
      const provisioning = await tx.tenantProvisioning.update({
        where: { tenantId: tenant.id },
        data: { status, step: missingAdmin ? 'ADMIN_REQUIRED' : 'ENVIRONMENT_READY', completedSteps, lastError: missingAdmin ? 'No active restaurant administrator is linked to this tenant.' : null, completedAt: missingAdmin ? null : new Date() },
      });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_PROVISIONING_RETRIED', entityType: 'TenantProvisioning', entityId: provisioning.id, metadata: { status, step: provisioning.step } } });
      return { provisioning, unit: { id: unit.id, name: unit.name }, missingAdmin };
    });
    return res.status(result.missingAdmin ? 409 : 200).json({ ...result, provisioning: publicProvisioning(result.provisioning) });
  } catch (error) {
    await prisma.tenantProvisioning.updateMany({ where: { tenantId: req.params.id }, data: { status: 'ERROR', step: 'RETRY_FAILED', lastError: 'Provisioning retry failed; inspect server logs.', completedAt: null } });
    return next(error);
  }
});
tenantRoutes.patch('/:id/status', async (req, res, next) => {
  try {
    const status = z.enum(['ACTIVE', 'TRIAL', 'SUSPENDED', 'BLOCKED']).safeParse(req.body?.status);
    if (!status.success) return res.status(400).json({ message: 'Invalid tenant status' });
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: { status: status.data } });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'TENANT_STATUS_CHANGED', entityType: 'Tenant', entityId: tenant.id, metadata: { status: status.data } } });
    return res.json(tenant);
  } catch (error) { return next(error); }
});

const licenseSchema = z.object({
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'CANCELLED']),
  planId: z.string().uuid().nullable().optional(),
  billingPeriod: z.nativeEnum(BillingPeriod).nullable().optional(),
  contractedPrice: z.number().min(0).max(10000000).nullable().optional(),
  activationFee: z.number().min(0).max(10000000).nullable().optional(),
  setupFee: z.number().min(0).max(10000000).nullable().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  maxUnits: z.number().int().min(1).nullable().optional(),
  maxUsers: z.number().int().min(1).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  modules: z.array(z.enum(MODULE_KEYS)).max(MODULE_KEYS.length),
});
tenantRoutes.get('/modules/catalog', (_req, res) => res.json({ items: MODULE_CATALOG }));
tenantRoutes.get('/:id/license', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, status: true, license: true, modules: { select: { moduleKey: true } }, _count: { select: { units: true, users: true } } } });
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    return res.json({ tenant: { id: tenant.id, name: tenant.name, status: tenant.status }, license: tenant.license, modules: tenant.modules.map(item => item.moduleKey), usage: tenant._count, restricted: Boolean(tenant.license) });
  } catch (error) { return next(error); }
});
tenantRoutes.put('/:id/license', async (req, res, next) => {
  try {
    const parsed = licenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true, license: true, modules: { select: { moduleKey: true } } } });
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    const { modules, validUntil, planId, ...fields } = parsed.data;
    const plan = planId ? await prisma.saaSPlan.findFirst({ where: { id: planId, active: true }, include: { modules: true, prices: true } }) : null;
    if (planId && !plan) return res.status(400).json({ message: 'Plano comercial inexistente ou inativo' });
    const billingPeriod = fields.billingPeriod ?? tenant.license?.billingPeriod ?? (plan?.prices.find(item => item.period === BillingPeriod.MONTHLY)?.period ?? plan?.prices[0]?.period ?? null);
    const planPrice = plan?.prices.find(item => item.period === billingPeriod)?.amount;
    const data = {
      ...fields, validUntil: validUntil ? new Date(validUntil) : null,
      maxUnits: fields.maxUnits === undefined ? (planId !== undefined ? plan?.maxUnits ?? null : tenant.license?.maxUnits ?? null) : fields.maxUnits,
      maxUsers: fields.maxUsers === undefined ? (planId !== undefined ? plan?.maxUsers ?? null : tenant.license?.maxUsers ?? null) : fields.maxUsers,
      notes: fields.notes === undefined ? tenant.license?.notes ?? null : fields.notes,
      planId: planId === undefined ? tenant.license?.planId ?? null : plan?.id ?? null,
      billingPeriod,
      contractedPrice: fields.contractedPrice === undefined
        ? (planId !== undefined ? planPrice ?? null : tenant.license?.contractedPrice ?? null)
        : fields.contractedPrice === null ? null : new Prisma.Decimal(fields.contractedPrice),
      activationFee: fields.activationFee === undefined
        ? (planId !== undefined ? plan?.activationFee ?? null : tenant.license?.activationFee ?? null)
        : fields.activationFee === null ? null : new Prisma.Decimal(fields.activationFee),
      setupFee: fields.setupFee === undefined
        ? (planId !== undefined ? plan?.setupFee ?? null : tenant.license?.setupFee ?? null)
        : fields.setupFee === null ? null : new Prisma.Decimal(fields.setupFee),
      discountPercent: fields.discountPercent === undefined
        ? tenant.license?.discountPercent ?? null
        : fields.discountPercent === null ? null : new Prisma.Decimal(fields.discountPercent),
    };
    const wanted = [...new Set(modules)];
    const result = await prisma.$transaction(async tx => {
      const license = await tx.tenantLicense.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, ...data }, update: data });
      await tx.tenantModule.deleteMany({ where: { tenantId: tenant.id, moduleKey: { notIn: wanted } } });
      await tx.tenantModule.createMany({ data: wanted.map(moduleKey => ({ tenantId: tenant.id, moduleKey })), skipDuplicates: true });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: 'LICENSE_UPDATED', entityType: 'TenantLicense', entityId: license.id, metadata: { before: { status: tenant.license?.status ?? null, modules: tenant.modules.map(item => item.moduleKey) }, after: { status: license.status, validUntil: license.validUntil?.toISOString() ?? null, modules: wanted } } } });
      return license;
    });
    return res.json({ license: result, modules: wanted });
  } catch (error) { return next(error); }
});
