import { Router } from 'express';
import { BillingPeriod, LicenseStatus, Prisma, SaaSInvoiceStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { invalidateBlockedModules } from '../lib/licensing';
import { isFeatureLinked, moduleSetProblem } from '../lib/module-catalog';
import { addMonths, addonRecurringCents, computeQuote, invoiceReference, PERIOD_MONTHS, promotionDenial, toCents, type DiscountRule, type Quote } from '../lib/commercial';
import { requireAuth, requireMaster } from '../middleware/auth';
import { audit } from './commercial';

export const commercialBillingRoutes = Router();
commercialBillingRoutes.use(requireAuth, requireMaster);

class CommercialError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

type QuoteOptions = { couponCode?: string | null; campaignId?: string | null; includeFees?: boolean; at?: Date };
type QuoteResult = { quote: Quote; period: BillingPeriod; reference: string; planId: string | null; couponId: string | null; campaignId: string | null; recurringCents: number; oneTimeKeys: string[] };

// Single pricing path used by the preview and by invoice generation, so both always agree.
async function buildQuote(tenantId: string, options: QuoteOptions = {}): Promise<QuoteResult> {
  const at = options.at ?? new Date();
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, license: true, modules: { select: { moduleKey: true, source: true, unitPrice: true, discountPercent: true, free: true, blocked: true, startsAt: true, endsAt: true } } },
  });
  if (!tenant) throw new CommercialError('Cliente não encontrado', 404);
  const license = tenant.license;
  if (!license) throw new CommercialError('O cliente ainda não possui assinatura/licença');
  const plan = license.planId ? await prisma.saaSPlan.findUnique({ where: { id: license.planId }, include: { prices: true, modules: true } }) : null;
  const period = license.billingPeriod ?? BillingPeriod.MONTHLY;
  const planPrice = license.contractedPrice ?? plan?.prices.find(item => item.period === period)?.amount;
  if (planPrice === null || planPrice === undefined) throw new CommercialError('A assinatura não tem preço contratado para a periodicidade escolhida');
  const planCents = toCents(planPrice);

  const includedKeys = new Set(plan?.modules.filter(item => !item.optional).map(item => item.moduleKey) ?? []);
  const optionalPrices = new Map(plan?.modules.filter(item => item.optional && item.priceOverride !== null).map(item => [item.moduleKey, item.priceOverride!]) ?? []);
  const addonRows = tenant.modules.filter(item => item.source === 'ADDON' && !includedKeys.has(item.moduleKey));
  const catalog = await prisma.saaSModule.findMany({ where: { key: { in: addonRows.map(item => item.moduleKey) } } });
  const addons = addonRows.flatMap(row => {
    const module = catalog.find(item => item.key === row.moduleKey);
    if (!module) return [];
    const cents = addonRecurringCents({ ...row, unitPrice: row.unitPrice ?? optionalPrices.get(row.moduleKey) }, module, period, at);
    return [{ key: row.moduleKey, label: `Módulo ${module.name}`, cents }];
  });
  const recurringCents = planCents + addons.reduce((sum, item) => sum + item.cents, 0);

  const previous = await prisma.saaSInvoice.findMany({ where: { tenantId, status: { not: 'CANCELLED' } }, select: { status: true, items: true } });
  const billedFees = new Set(previous.flatMap(invoice => (Array.isArray(invoice.items) ? invoice.items as { type?: string; key?: string }[] : []).filter(line => line.type === 'FEE' && line.key).map(line => line.key!)));
  const isNewCustomer = !previous.some(invoice => invoice.status === 'PAID');
  const fees: { label: string; cents: number; key: string }[] = [];
  if (options.includeFees ?? previous.length === 0) {
    if (!billedFees.has('activation') && license.activationFee) fees.push({ key: 'activation', label: 'Taxa de ativação', cents: toCents(license.activationFee) });
    if (!billedFees.has('setup') && license.setupFee) fees.push({ key: 'setup', label: 'Taxa de implantação', cents: toCents(license.setupFee) });
  }
  const oneTimeKeys: string[] = [];
  for (const row of addonRows) {
    const module = catalog.find(item => item.key === row.moduleKey);
    if (module?.billing === 'ONE_TIME' && !row.free && !billedFees.has(`module:${row.moduleKey}`)) {
      const base = toCents(row.unitPrice ?? module.oneTimePrice);
      const cents = Math.round(base * (100 - Number(row.discountPercent ?? 0)) / 100);
      if (cents > 0) { fees.push({ key: `module:${row.moduleKey}`, label: `Módulo ${module.name} (taxa única)`, cents }); oneTimeKeys.push(row.moduleKey); }
    }
  }

  const discounts: DiscountRule[] = [];
  if (license.discountPercent && Number(license.discountPercent) > 0) discounts.push({ label: `Desconto negociado (${Number(license.discountPercent)}%)`, type: 'PERCENT', value: Number(license.discountPercent), source: 'NEGOTIATED' });
  const moduleKeys = tenant.modules.filter(item => !item.blocked).map(item => item.moduleKey);
  let couponId: string | null = null;
  let campaignId: string | null = null;
  const promoContext = async (field: 'couponId' | 'campaignId', id: string) => {
    const [totalUses, tenantUses] = await Promise.all([prisma.saaSCouponRedemption.count({ where: { [field]: id } }), prisma.saaSCouponRedemption.count({ where: { [field]: id, tenantId } })]);
    return { now: at, planId: license.planId, moduleKeys, isNewCustomer, totalUses, tenantUses, recurringCents };
  };
  if (options.couponCode) {
    const coupon = await prisma.saaSCoupon.findUnique({ where: { code: options.couponCode.trim().toUpperCase() } });
    if (!coupon) throw new CommercialError('Cupom inexistente');
    const denial = promotionDenial(coupon, await promoContext('couponId', coupon.id));
    if (denial) throw new CommercialError(`Cupom ${coupon.code}: ${denial}`);
    couponId = coupon.id;
    discounts.push({ label: `Cupom ${coupon.code}`, type: coupon.discountType, value: Number(coupon.discountValue), source: 'COUPON' });
  }
  if (options.campaignId) {
    const campaign = await prisma.saaSCampaign.findUnique({ where: { id: options.campaignId } });
    if (!campaign) throw new CommercialError('Promoção inexistente');
    const denial = promotionDenial(campaign, await promoContext('campaignId', campaign.id));
    if (denial) throw new CommercialError(`Promoção ${campaign.name}: ${denial}`);
    campaignId = campaign.id;
    discounts.push({ label: `Promoção ${campaign.name}`, type: campaign.discountType, value: Number(campaign.discountValue), source: 'CAMPAIGN' });
  }

  const quote = computeQuote({ planLabel: plan ? `Plano ${plan.name} (${period})` : `Assinatura (${period})`, planCents, addons, fees, discounts });
  // Fee lines keep their key so the same fee is never billed twice.
  for (const line of quote.lines) if (line.type === 'FEE') line.key = fees.find(fee => fee.label === line.label)?.key;
  return { quote, period, reference: invoiceReference(period, at), planId: license.planId, couponId, campaignId, recurringCents, oneTimeKeys };
}

const handle = (error: unknown, res: { status: (code: number) => { json: (body: unknown) => unknown } }, next: (error: unknown) => void) =>
  error instanceof CommercialError ? res.status(error.status).json({ message: error.message }) : next(error);

const quoteSchema = z.object({ tenantId: z.string().uuid(), couponCode: z.string().max(40).nullable().optional(), campaignId: z.string().uuid().nullable().optional(), includeFees: z.boolean().optional() });

commercialBillingRoutes.post('/coupons/validate', async (req, res, next) => {
  try {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.couponCode) return res.status(400).json({ message: 'Informe o cliente e o código do cupom' });
    const result = await buildQuote(parsed.data.tenantId, { couponCode: parsed.data.couponCode, includeFees: false });
    return res.json({ valid: true, quote: result.quote });
  } catch (error) { return handle(error, res, next); }
});

commercialBillingRoutes.post('/invoices/quote', async (req, res, next) => {
  try {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { quote, period, reference } = await buildQuote(parsed.data.tenantId, parsed.data);
    return res.json({ quote, period, reference });
  } catch (error) { return handle(error, res, next); }
});

commercialBillingRoutes.get('/invoices', async (req, res, next) => {
  try {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30),
      status: z.enum(['OPEN', 'PAID', 'CANCELLED', 'OVERDUE']).optional(), tenantId: z.string().uuid().optional(), q: z.string().trim().max(80).optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters' });
    const { page, pageSize, status, tenantId, q } = query.data;
    const now = new Date();
    const where: Prisma.SaaSInvoiceWhereInput = {
      ...(tenantId ? { tenantId } : {}), ...(q ? { tenant: { name: { contains: q, mode: 'insensitive' } } } : {}),
      ...(status === 'OVERDUE' ? { status: 'OPEN', dueDate: { lt: now } } : status ? { status: status as SaaSInvoiceStatus } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.saaSInvoice.findMany({ where, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { tenant: { select: { id: true, name: true } }, plan: { select: { name: true } }, coupon: { select: { code: true } }, campaign: { select: { name: true } } } }),
      prisma.saaSInvoice.count({ where }),
    ]);
    return res.json({ items: items.map(item => ({ ...item, overdue: item.status === 'OPEN' && item.dueDate < now })), total, page, pageSize });
  } catch (error) { return next(error); }
});

const createSchema = quoteSchema.extend({ dueDate: z.string().datetime(), notes: z.string().max(500).nullable().optional(), referenceDate: z.string().datetime().optional() });
commercialBillingRoutes.post('/invoices', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const input = parsed.data;
    const built = await buildQuote(input.tenantId, { ...input, at: input.referenceDate ? new Date(input.referenceDate) : undefined });
    const invoice = await prisma.$transaction(async tx => {
      const created = await tx.saaSInvoice.create({
        data: {
          tenantId: input.tenantId, planId: built.planId, reference: built.reference, period: built.period, items: built.quote.lines as unknown as Prisma.InputJsonValue,
          subtotal: new Prisma.Decimal(built.quote.subtotal), discount: new Prisma.Decimal(built.quote.discount), total: new Prisma.Decimal(built.quote.total),
          dueDate: new Date(input.dueDate), couponId: built.couponId, campaignId: built.campaignId, notes: input.notes ?? null, createdBy: req.auth!.userId,
        },
      });
      for (const source of [{ couponId: built.couponId }, { campaignId: built.campaignId }]) {
        const [key, id] = Object.entries(source)[0];
        if (!id) continue;
        const amount = built.quote.lines.filter(line => line.type === 'DISCOUNT' && line.label.startsWith(key === 'couponId' ? 'Cupom' : 'Promoção')).reduce((sum, line) => sum - line.amount, 0);
        await tx.saaSCouponRedemption.create({ data: { [key]: id, tenantId: input.tenantId, invoiceId: created.id, amount: new Prisma.Decimal(amount), actorUserId: req.auth!.userId } as Prisma.SaaSCouponRedemptionUncheckedCreateInput });
      }
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: input.tenantId, action: 'SAAS_INVOICE_CREATED', entityType: 'SaaSInvoice', entityId: created.id, metadata: { reference: built.reference, total: built.quote.total, discount: built.quote.discount, couponId: built.couponId, campaignId: built.campaignId } } });
      return created;
    });
    return res.status(201).json(invoice);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe uma cobrança ativa para esta competência. Cancele-a antes de emitir outra.' });
    return handle(error, res, next);
  }
});

// Payment is only registered by an administrator (manual reconciliation) — never assumed. A provider webhook must call the same transition.
commercialBillingRoutes.post('/invoices/:id/pay', async (req, res, next) => {
  try {
    const input = z.object({ method: z.string().trim().min(2).max(40), reference: z.string().trim().max(120).optional(), paidAt: z.string().datetime().optional(), extendLicense: z.boolean().default(true), notes: z.string().max(300).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe a forma de pagamento', errors: input.error.flatten() });
    const paidAt = input.data.paidAt ? new Date(input.data.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + 86_400_000) return res.status(400).json({ message: 'A data de pagamento não pode estar no futuro' });
    const result = await prisma.$transaction(async tx => {
      const invoice = await tx.saaSInvoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) throw new CommercialError('Cobrança não encontrada', 404);
      const claimed = await tx.saaSInvoice.updateMany({ where: { id: invoice.id, status: 'OPEN' }, data: { status: 'PAID', paidAt, paymentMethod: input.data.method, paymentReference: input.data.reference ?? null, paidBy: req.auth!.userId, notes: input.data.notes ?? invoice.notes } });
      if (claimed.count === 0) throw new CommercialError(`Cobrança já está ${invoice.status === 'PAID' ? 'paga' : 'cancelada'}`, 409);
      let validUntil: Date | null = null;
      if (input.data.extendLicense && invoice.period) {
        const license = await tx.tenantLicense.findUnique({ where: { tenantId: invoice.tenantId } });
        if (license) {
          const base = license.validUntil && license.validUntil > paidAt ? license.validUntil : paidAt;
          validUntil = addMonths(base, PERIOD_MONTHS[invoice.period]);
          await tx.tenantLicense.update({ where: { tenantId: invoice.tenantId }, data: { validUntil, ...(license.status === LicenseStatus.PENDING ? { status: LicenseStatus.ACTIVE } : {}) } });
        }
      }
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: invoice.tenantId, action: 'SAAS_INVOICE_PAID', entityType: 'SaaSInvoice', entityId: invoice.id, metadata: { total: invoice.total, method: input.data.method, reference: input.data.reference ?? null, paidAt, validUntil, source: 'MANUAL_RECONCILIATION' } } });
      return tx.saaSInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    });
    return res.json(result);
  } catch (error) { return handle(error, res, next); }
});

commercialBillingRoutes.post('/invoices/:id/cancel', async (req, res, next) => {
  try {
    const input = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe o motivo do cancelamento' });
    const result = await prisma.$transaction(async tx => {
      const invoice = await tx.saaSInvoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) throw new CommercialError('Cobrança não encontrada', 404);
      const claimed = await tx.saaSInvoice.updateMany({ where: { id: invoice.id, status: 'OPEN' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: input.data.reason } });
      if (claimed.count === 0) throw new CommercialError('Somente cobranças em aberto podem ser canceladas', 409);
      await tx.saaSCouponRedemption.deleteMany({ where: { invoiceId: invoice.id } });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: invoice.tenantId, action: 'SAAS_INVOICE_CANCELLED', entityType: 'SaaSInvoice', entityId: invoice.id, metadata: { total: invoice.total, reason: input.data.reason } } });
      return tx.saaSInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    });
    return res.json(result);
  } catch (error) { return handle(error, res, next); }
});

// ---------- Customer commercial record (reuses Tenant/TenantLicense/TenantModule) ----------
commercialBillingRoutes.get('/tenants/:id', async (req, res, next) => {
  try {
    const now = new Date();
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, slug: true, status: true, createdAt: true, license: { include: { plan: { select: { id: true, name: true } } } }, modules: { orderBy: { moduleKey: 'asc' } }, _count: { select: { users: true, units: true } } },
    });
    if (!tenant) return res.status(404).json({ message: 'Cliente não encontrado' });
    const [catalog, invoices, history] = await Promise.all([
      prisma.saaSModule.findMany({ select: { key: true, name: true, monthlyPrice: true, billing: true } }),
      prisma.saaSInvoice.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'desc' }, take: 24, select: { id: true, seq: true, reference: true, status: true, total: true, discount: true, dueDate: true, paidAt: true, paymentMethod: true } }),
      prisma.auditLog.findMany({ where: { tenantId: tenant.id, OR: [{ action: { startsWith: 'SAAS_' } }, { action: { startsWith: 'SUBSCRIPTION_' } }, { action: { startsWith: 'LICENSE_' } }, { action: { startsWith: 'ADDON_' } }, { action: 'TENANT_STATUS_CHANGED' }] }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, action: true, metadata: true, createdAt: true, actor: { select: { name: true } } } }),
    ]);
    const open = invoices.filter(item => item.status === 'OPEN');
    return res.json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, createdAt: tenant.createdAt, users: tenant._count.users, units: tenant._count.units },
      license: tenant.license,
      modules: tenant.modules.map(row => ({ ...row, name: catalog.find(item => item.key === row.moduleKey)?.name ?? row.moduleKey, active: !row.blocked && (!row.startsAt || row.startsAt <= now) && (!row.endsAt || row.endsAt >= now) })),
      invoices, history,
      finance: { open: open.reduce((sum, item) => sum + Number(item.total), 0), overdue: open.filter(item => item.dueDate < now).reduce((sum, item) => sum + Number(item.total), 0), paid: invoices.filter(item => item.status === 'PAID').reduce((sum, item) => sum + Number(item.total), 0) },
    });
  } catch (error) { return next(error); }
});

const addonSchema = z.object({
  moduleKey: z.string().min(1).max(80),
  action: z.enum(['ADD', 'UPDATE', 'REMOVE', 'BLOCK', 'UNBLOCK']),
  unitPrice: z.number().min(0).max(10000000).nullable().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  free: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(300).nullable().optional(),
  reason: z.string().trim().min(3).max(300),
});
commercialBillingRoutes.put('/tenants/:id/addons', async (req, res, next) => {
  try {
    const parsed = addonSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Informe o módulo, a ação e o motivo', errors: parsed.error.flatten() });
    const input = parsed.data;
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true, license: true, modules: true } });
    if (!tenant) return res.status(404).json({ message: 'Cliente não encontrado' });
    const current = tenant.modules.find(item => item.moduleKey === input.moduleKey);
    if (input.endsAt && input.startsAt && new Date(input.endsAt) <= new Date(input.startsAt)) return res.status(400).json({ message: 'O término deve ser posterior ao início' });
    const module = await prisma.saaSModule.findUnique({ where: { key: input.moduleKey } });
    if (!module) return res.status(404).json({ message: 'Módulo inexistente no catálogo' });

    if (input.action === 'ADD') {
      if (current) return res.status(409).json({ message: 'O cliente já possui este módulo' });
      if (!module.standalone) return res.status(400).json({ message: 'Este módulo não está disponível para contratação avulsa' });
      if (module.status !== 'ACTIVE') return res.status(400).json({ message: 'Módulo indisponível para novas contratações' });
      const problem = await moduleSetProblem([input.moduleKey, ...tenant.modules.filter(item => !item.blocked).map(item => item.moduleKey)]);
      if (problem) return res.status(400).json({ message: problem });
    } else if (!current) return res.status(404).json({ message: 'O cliente não possui este módulo' });
    if (input.action === 'REMOVE' || input.action === 'BLOCK') {
      const dependants = await prisma.saaSModule.findMany({ where: { dependsOn: { has: input.moduleKey }, key: { in: tenant.modules.filter(item => !item.blocked && item.moduleKey !== input.moduleKey).map(item => item.moduleKey) } }, select: { name: true } });
      if (dependants.length > 0) return res.status(409).json({ message: `Outros módulos dependem deste: ${dependants.map(item => item.name).join(', ')}` });
    }

    const fields = {
      ...(input.unitPrice !== undefined ? { unitPrice: input.unitPrice === null ? null : new Prisma.Decimal(input.unitPrice) } : {}),
      ...(input.discountPercent !== undefined ? { discountPercent: input.discountPercent === null ? null : new Prisma.Decimal(input.discountPercent) } : {}),
      ...(input.free !== undefined ? { free: input.free } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    await prisma.$transaction(async tx => {
      if (input.action === 'ADD') await tx.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: input.moduleKey, source: 'ADDON', ...fields } });
      else if (input.action === 'REMOVE') await tx.tenantModule.delete({ where: { id: current!.id } });
      else if (input.action === 'BLOCK') await tx.tenantModule.update({ where: { id: current!.id }, data: { blocked: true } });
      else if (input.action === 'UNBLOCK') await tx.tenantModule.update({ where: { id: current!.id }, data: { blocked: false } });
      else await tx.tenantModule.update({ where: { id: current!.id }, data: fields });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: tenant.id, action: `ADDON_${input.action}`, entityType: 'TenantModule', entityId: current?.id ?? null, metadata: JSON.parse(JSON.stringify({ moduleKey: input.moduleKey, reason: input.reason, linked: isFeatureLinked(input.moduleKey), before: current ? { unitPrice: current.unitPrice, discountPercent: current.discountPercent, free: current.free, blocked: current.blocked, startsAt: current.startsAt, endsAt: current.endsAt } : null, after: fields })) } });
    });
    invalidateBlockedModules();
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

// Suspension never deletes data: it only flips the license status, which requireAuth enforces on every tenant request.
commercialBillingRoutes.post('/tenants/:id/access', async (req, res, next) => {
  try {
    const input = z.object({ action: z.enum(['SUSPEND', 'REACTIVATE']), reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe a ação e o motivo' });
    const license = await prisma.tenantLicense.findUnique({ where: { tenantId: req.params.id } });
    if (!license) return res.status(404).json({ message: 'O cliente não possui assinatura' });
    const status = input.data.action === 'SUSPEND' ? LicenseStatus.SUSPENDED : LicenseStatus.ACTIVE;
    await prisma.$transaction([
      prisma.tenantLicense.update({ where: { tenantId: license.tenantId }, data: { status } }),
      prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId: license.tenantId, action: input.data.action === 'SUSPEND' ? 'SUBSCRIPTION_SUSPENDED' : 'SUBSCRIPTION_REACTIVATED', entityType: 'TenantLicense', entityId: license.id, metadata: { before: license.status, after: status, reason: input.data.reason } } }),
    ]);
    return res.json({ ok: true, status });
  } catch (error) { return next(error); }
});
