import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, FINANCE_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { activeFilter, audit, isUniqueViolation, listQuerySchema, unitReadScope, validationError } from '../lib/registry';

/**
 * Fiscal/Tributos: regras tributárias (NCM, CEST, CFOP, origem, ICMS/ST/FCP, PIS, COFINS, IPI, IBS/CBS/IS, cClassTrib, cBenef) com vigência.
 * As alíquotas são parâmetros da empresa (nada fixo no código) e são repassadas ao provedor fiscal na emissão (/fiscal).
 * Fora da vigência a regra é ignorada e vale a regra padrão da empresa (Configurações > Fiscais).
 */
export const taxRuleRoutes = Router();
taxRuleRoutes.use(requireAuth, requireTenant, allowRead(FINANCE_ROLES, MANAGEMENT_ROLES));

const digits = (length: number, label: string) => z.string().trim().nullish().transform((value, ctx) => {
  const only = (value ?? '').replace(/\D/g, '');
  if (!only) return null;
  if (only.length !== length) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} deve ter ${length} dígitos` }); return z.NEVER; }
  return only;
});
const cst = (label: string) => z.string().trim().regex(/^\d{2,3}$/, `${label} deve ter 2 ou 3 dígitos`).nullish().transform(value => value || null);
const rate = z.number().finite().min(0).max(100).multipleOf(0.001).nullish();

const baseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  ncm: digits(8, 'NCM'),
  cest: digits(7, 'CEST'),
  origin: z.number().int().min(0).max(8).default(0),
  cfop: digits(4, 'CFOP'),
  icmsCst: cst('CST/CSOSN do ICMS'),
  icmsRate: rate,
  icmsReduction: rate,
  pisCst: cst('CST do PIS'),
  pisRate: rate,
  cofinsCst: cst('CST da COFINS'),
  cofinsRate: rate,
  icmsStMva: rate, icmsStRate: rate, icmsStReduction: rate, fcpRate: rate, fcpStRate: rate,
  cBenef: z.string().trim().regex(/^([A-Z]{2}\d{6}|[A-Z]{2}[A-Z0-9]{6})?$/, 'cBenef deve ter 8 caracteres (ex.: MT000001)').nullish().transform(value => value || null),
  ipiCst: cst('CST do IPI'), ipiEnquadramento: digits(3, 'Código de enquadramento do IPI'), ipiRate: rate,
  ibsCbsCst: z.string().trim().regex(/^\d{3}$/, 'CST IBS/CBS deve ter 3 dígitos').nullish().transform(value => value || null), cClassTrib: digits(6, 'cClassTrib'),
  ibsUfRate: rate, ibsMunRate: rate, cbsRate: rate, isRate: rate,
  validFrom: z.coerce.date().nullish(), validTo: z.coerce.date().nullish(),
  active: z.boolean().default(true),
});
const validPeriod = (value: { validFrom?: Date | null; validTo?: Date | null }) => !value.validFrom || !value.validTo || value.validFrom <= value.validTo;
const periodIssue = { message: 'A vigência final deve ser posterior à inicial', path: ['validTo'] };
const schema = baseSchema.refine(validPeriod, periodIssue);
const conflict = { message: 'Já existe uma regra com esse nome.' };
const idsSchema = z.object({ productIds: z.array(z.string().uuid()).min(1).max(500) });
const ruleScope = (req: Parameters<typeof unitReadScope>[0], id: string) => ({ id, tenantId: req.auth!.tenantId! });

taxRuleRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const items = await prisma.taxRule.findMany({ where: { tenantId: req.auth!.tenantId!, ...activeFilter(active), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { ncm: { contains: q.replace(/\D/g, '') || '\u0000' } }] } : {}) }, include: { _count: { select: { products: true } } }, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

taxRuleRoutes.post('/', async (req, res, next) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    if (await prisma.taxRule.findFirst({ where: { tenantId, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const created = await prisma.taxRule.create({ data: { ...parsed.data, tenantId } });
    await audit(req, 'TAX_RULE_CREATED', 'TaxRule', created.id);
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

taxRuleRoutes.get('/:id/products', async (req, res, next) => {
  try {
    const rule = await prisma.taxRule.findFirst({ where: ruleScope(req, req.params.id), select: { id: true } }); if (!rule) return res.status(404).json({ message: 'Regra não encontrada.' });
    const items = await prisma.product.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitReadScope(req), taxRuleId: rule.id }, select: { id: true, name: true, code: true, price: true, active: true, ncm: true, category: { select: { id: true, name: true } } }, orderBy: { name: 'asc' }, take: 1000 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

// Bulk link: only products of this tenant (and the caller's unit, when scoped) are accepted.
taxRuleRoutes.post('/:id/assign', async (req, res, next) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const parsed = idsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!; const productIds = [...new Set(parsed.data.productIds)];
    const rule = await prisma.taxRule.findFirst({ where: ruleScope(req, req.params.id) }); if (!rule) return res.status(404).json({ message: 'Regra não encontrada.' });
    if (!rule.active) return res.status(409).json({ message: 'Ative a regra antes de vincular produtos.' });
    const where = { tenantId, ...unitReadScope(req), id: { in: productIds } };
    const updated = await prisma.$transaction(async tx => {
      if (await tx.product.count({ where }) !== productIds.length) return null;
      const result = await tx.product.updateMany({ where, data: { taxRuleId: rule.id } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'TAX_RULE_ASSIGNED', entityType: 'TaxRule', entityId: rule.id, metadata: { products: result.count } } });
      return result.count;
    });
    if (updated === null) return res.status(400).json({ message: 'Um ou mais produtos não existem nesta empresa.' });
    return res.json({ updated });
  } catch (error) { return next(error); }
});

taxRuleRoutes.post('/:id/unassign', async (req, res, next) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const parsed = idsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const rule = await prisma.taxRule.findFirst({ where: ruleScope(req, req.params.id), select: { id: true } }); if (!rule) return res.status(404).json({ message: 'Regra não encontrada.' });
    const result = await prisma.product.updateMany({ where: { tenantId, ...unitReadScope(req), taxRuleId: rule.id, id: { in: parsed.data.productIds } }, data: { taxRuleId: null } });
    await audit(req, 'TAX_RULE_UNASSIGNED', 'TaxRule', rule.id, { products: result.count });
    return res.json({ updated: result.count });
  } catch (error) { return next(error); }
});

taxRuleRoutes.patch('/:id', async (req, res, next) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const parsed = baseSchema.partial().refine(validPeriod, periodIssue).safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.taxRule.findFirst({ where: ruleScope(req, req.params.id) }); if (!current) return res.status(404).json({ message: 'Regra não encontrada.' });
    if (parsed.data.name && await prisma.taxRule.findFirst({ where: { tenantId, id: { not: current.id }, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const updated = await prisma.taxRule.update({ where: { id: current.id }, data: parsed.data });
    await audit(req, parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'TAX_RULE_ACTIVATED' : 'TAX_RULE_DEACTIVATED') : 'TAX_RULE_UPDATED', 'TaxRule', current.id);
    return res.json(updated);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

// Rules linked to products are deactivated instead of deleted.
taxRuleRoutes.delete('/:id', async (req, res, next) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.auth!.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    const current = await prisma.taxRule.findFirst({ where: ruleScope(req, req.params.id) }); if (!current) return res.status(404).json({ message: 'Regra não encontrada.' });
    if (await prisma.product.count({ where: { tenantId: req.auth!.tenantId!, taxRuleId: current.id } }) > 0) {
      const updated = await prisma.taxRule.update({ where: { id: current.id }, data: { active: false } });
      await audit(req, 'TAX_RULE_DEACTIVATED', 'TaxRule', current.id);
      return res.json({ deleted: false, deactivated: true, rule: updated });
    }
    await prisma.taxRule.delete({ where: { id: current.id } });
    await audit(req, 'TAX_RULE_DELETED', 'TaxRule', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
