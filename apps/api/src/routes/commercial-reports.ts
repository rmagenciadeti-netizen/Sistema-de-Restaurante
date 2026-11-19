import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';
import { finalizeReport, parsePeriod, reportToCsv, sumDecimals, D, type ReportBody } from '../lib/report-helpers';
import { EXPORT_FORMATS, isExportFormat, reportToPdf, reportToXlsx } from '../lib/report-export';

// Commercial reports of the RM Painel Admin (platform level, master only). They are built from the existing commercial tables
// (licences, invoices, redemptions, audit log) and export through the same Excel/PDF/CSV writers as the restaurant reports.
export const commercialReportsRoutes = Router();
commercialReportsRoutes.use(requireAuth, requireMaster);

type Ctx = { from: Date; to: Date; now: Date };
const TIME_ZONE = 'America/Sao_Paulo';
const monthKey = (date: Date) => date.toISOString().slice(0, 7);
const text = (value: string | null | undefined) => value ?? '—';
type InvoiceLine = { type?: string; key?: string; label?: string; amount?: number };
const linesOf = (items: Prisma.JsonValue): InvoiceLine[] => (Array.isArray(items) ? items as InvoiceLine[] : []);

async function tenantNames(ids: string[]) {
  const tenants = await prisma.tenant.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(tenants.map(tenant => [tenant.id, tenant.name]));
}

const REPORTS: Record<string, { title: string; description: string; build: (ctx: Ctx) => Promise<ReportBody> }> = {
  'subscriptions-by-plan': {
    title: 'Assinaturas por plano', description: 'Situação atual das assinaturas em cada plano e a receita recorrente contratada.',
    build: async () => {
      const [plans, licenses] = await Promise.all([prisma.saaSPlan.findMany({ select: { id: true, name: true, status: true } }), prisma.tenantLicense.findMany({ select: { planId: true, status: true, contractedPrice: true, billingPeriod: true, discountPercent: true } })]);
      const months = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 } as Record<string, number>;
      const mrr = (license: (typeof licenses)[number]) => D(license.contractedPrice).mul(1 - Number(license.discountPercent ?? 0) / 100).div(months[license.billingPeriod ?? 'MONTHLY'] ?? 1);
      const rows = [...plans.map(plan => ({ id: plan.id as string | null, name: plan.name, state: plan.status })), { id: null, name: 'Sem plano', state: '—' }].map(plan => {
        const own = licenses.filter(license => license.planId === plan.id);
        const active = own.filter(license => license.status === 'ACTIVE');
        return { plan: plan.name, planStatus: plan.state, total: own.length, active: active.length, suspended: own.filter(license => license.status === 'SUSPENDED').length, cancelled: own.filter(license => ['CANCELLED', 'REVOKED'].includes(license.status)).length, mrr: sumDecimals(active.map(mrr)).toDecimalPlaces(2) };
      }).filter(row => row.total > 0 || row.planStatus !== '—');
      return { columns: [{ key: 'plan', label: 'Plano', type: 'text' }, { key: 'planStatus', label: 'Situação do plano', type: 'text' }, { key: 'total', label: 'Assinaturas', type: 'number' }, { key: 'active', label: 'Ativas', type: 'number' }, { key: 'suspended', label: 'Suspensas', type: 'number' }, { key: 'cancelled', label: 'Canceladas', type: 'number' }, { key: 'mrr', label: 'MRR contratado', type: 'money' }], rows, totals: { total: rows.reduce((sum, row) => sum + row.total, 0), active: rows.reduce((sum, row) => sum + row.active, 0), mrr: sumDecimals(rows.map(row => row.mrr)) } };
    },
  },
  'revenue-by-plan': {
    title: 'Receita por plano', description: 'Cobranças pagas no período, por plano, com descontos concedidos.',
    build: async ({ from, to }) => {
      const [plans, invoices] = await Promise.all([prisma.saaSPlan.findMany({ select: { id: true, name: true } }), prisma.saaSInvoice.findMany({ where: { status: 'PAID', paidAt: { gte: from, lte: to } }, select: { planId: true, total: true, discount: true } })]);
      const names = new Map(plans.map(plan => [plan.id, plan.name]));
      const groups = new Map<string, { plan: string; invoices: number; received: Prisma.Decimal; discounts: Prisma.Decimal }>();
      for (const invoice of invoices) {
        const key = invoice.planId ?? 'none';
        const group = groups.get(key) ?? { plan: invoice.planId ? names.get(invoice.planId) ?? 'Plano removido' : 'Sem plano', invoices: 0, received: D(0), discounts: D(0) };
        group.invoices += 1; group.received = group.received.add(invoice.total); group.discounts = group.discounts.add(invoice.discount); groups.set(key, group);
      }
      const rows = [...groups.values()].sort((a, b) => b.received.comparedTo(a.received));
      return { columns: [{ key: 'plan', label: 'Plano', type: 'text' }, { key: 'invoices', label: 'Cobranças pagas', type: 'number' }, { key: 'received', label: 'Recebido', type: 'money' }, { key: 'discounts', label: 'Descontos', type: 'money' }], rows, totals: { invoices: rows.reduce((sum, row) => sum + row.invoices, 0), received: sumDecimals(rows.map(row => row.received)), discounts: sumDecimals(rows.map(row => row.discounts)) } };
    },
  },
  'revenue-by-module': {
    title: 'Receita por módulo', description: 'Valor de módulos adicionais nas cobranças pagas do período.',
    build: async ({ from, to }) => {
      const invoices = await prisma.saaSInvoice.findMany({ where: { status: 'PAID', paidAt: { gte: from, lte: to } }, select: { items: true } });
      const groups = new Map<string, { module: string; invoices: number; amount: number }>();
      for (const invoice of invoices) for (const line of linesOf(invoice.items)) if (line.type === 'MODULE') {
        const key = line.key ?? line.label ?? 'módulo';
        const group = groups.get(key) ?? { module: line.label ?? key, invoices: 0, amount: 0 };
        group.invoices += 1; group.amount += Number(line.amount ?? 0); groups.set(key, group);
      }
      const rows = [...groups.values()].sort((a, b) => b.amount - a.amount);
      return { columns: [{ key: 'module', label: 'Módulo', type: 'text' }, { key: 'invoices', label: 'Cobranças', type: 'number' }, { key: 'amount', label: 'Valor', type: 'money' }], rows, totals: { invoices: rows.reduce((sum, row) => sum + row.invoices, 0), amount: rows.reduce((sum, row) => sum + row.amount, 0) } };
    },
  },
  'top-modules': {
    title: 'Módulos mais contratados', description: 'Clientes com cada módulo liberado hoje (incluído no plano ou adicional).',
    build: async () => {
      const [catalog, grants] = await Promise.all([prisma.saaSModule.findMany({ select: { key: true, name: true } }), prisma.tenantModule.groupBy({ by: ['moduleKey', 'source'], where: { blocked: false }, _count: { _all: true } })]);
      const rows = catalog.map(module => {
        const plan = grants.find(grant => grant.moduleKey === module.key && grant.source !== 'ADDON')?._count._all ?? 0;
        const addon = grants.find(grant => grant.moduleKey === module.key && grant.source === 'ADDON')?._count._all ?? 0;
        return { module: module.name, tenants: plan + addon, viaPlan: plan, addon };
      }).sort((a, b) => b.tenants - a.tenants);
      return { columns: [{ key: 'module', label: 'Módulo', type: 'text' }, { key: 'tenants', label: 'Clientes', type: 'number' }, { key: 'viaPlan', label: 'Pelo plano', type: 'number' }, { key: 'addon', label: 'Adicional', type: 'number' }], rows };
    },
  },
  clients: {
    title: 'Clientes ativos e inativos', description: 'Todos os estabelecimentos com plano, vencimento e situação da assinatura.',
    build: async ({ now }) => {
      const tenants = await prisma.tenant.findMany({ orderBy: { name: 'asc' }, take: 5000, select: { name: true, status: true, createdAt: true, license: { select: { status: true, validUntil: true, plan: { select: { name: true } } } } } });
      const rows = tenants.map(tenant => ({ name: tenant.name, tenantStatus: tenant.status, plan: text(tenant.license?.plan?.name), licenseStatus: tenant.license?.status ?? 'SEM LICENÇA', validUntil: tenant.license?.validUntil ?? null, active: tenant.status === 'ACTIVE' && tenant.license?.status === 'ACTIVE' && (!tenant.license.validUntil || tenant.license.validUntil >= now) ? 'Ativo' : 'Inativo', createdAt: tenant.createdAt }));
      return { columns: [{ key: 'name', label: 'Cliente', type: 'text' }, { key: 'active', label: 'Situação', type: 'text' }, { key: 'tenantStatus', label: 'Cadastro', type: 'text' }, { key: 'plan', label: 'Plano', type: 'text' }, { key: 'licenseStatus', label: 'Assinatura', type: 'text' }, { key: 'validUntil', label: 'Vencimento', type: 'datetime' }, { key: 'createdAt', label: 'Cadastro em', type: 'datetime' }], rows, ...(tenants.length >= 5000 ? { truncated: true } : {}) };
    },
  },
  'new-contracts': {
    title: 'Novas contratações', description: 'Assinaturas criadas no período.',
    build: async ({ from, to }) => {
      const licenses = await prisma.tenantLicense.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, take: 5000, select: { createdAt: true, status: true, billingPeriod: true, contractedPrice: true, tenant: { select: { name: true } }, plan: { select: { name: true } } } });
      const rows = licenses.map(license => ({ createdAt: license.createdAt, tenant: license.tenant.name, plan: text(license.plan?.name), period: text(license.billingPeriod), price: license.contractedPrice, status: license.status }));
      return { columns: [{ key: 'createdAt', label: 'Data', type: 'datetime' }, { key: 'tenant', label: 'Cliente', type: 'text' }, { key: 'plan', label: 'Plano', type: 'text' }, { key: 'period', label: 'Periodicidade', type: 'text' }, { key: 'price', label: 'Valor contratado', type: 'money' }, { key: 'status', label: 'Situação', type: 'text' }], rows, totals: { price: sumDecimals(rows.map(row => row.price)) } };
    },
  },
  cancellations: {
    title: 'Cancelamentos', description: 'Assinaturas canceladas ou revogadas com última alteração no período.',
    build: async ({ from, to }) => {
      const licenses = await prisma.tenantLicense.findMany({ where: { status: { in: ['CANCELLED', 'REVOKED'] }, updatedAt: { gte: from, lte: to } }, orderBy: { updatedAt: 'desc' }, take: 5000, select: { updatedAt: true, status: true, notes: true, contractedPrice: true, tenant: { select: { name: true } }, plan: { select: { name: true } } } });
      const rows = licenses.map(license => ({ at: license.updatedAt, tenant: license.tenant.name, plan: text(license.plan?.name), price: license.contractedPrice, status: license.status, notes: text(license.notes) }));
      return { columns: [{ key: 'at', label: 'Data', type: 'datetime' }, { key: 'tenant', label: 'Cliente', type: 'text' }, { key: 'plan', label: 'Plano', type: 'text' }, { key: 'price', label: 'Valor contratado', type: 'money' }, { key: 'status', label: 'Situação', type: 'text' }, { key: 'notes', label: 'Observações', type: 'text' }], rows, totals: { price: sumDecimals(rows.map(row => row.price)) } };
    },
  },
  delinquency: {
    title: 'Inadimplência', description: 'Cobranças em aberto e vencidas na data da consulta.',
    build: async ({ now }) => {
      const invoices = await prisma.saaSInvoice.findMany({ where: { status: 'OPEN', dueDate: { lt: now } }, orderBy: { dueDate: 'asc' }, take: 5000, select: { tenantId: true, reference: true, dueDate: true, total: true } });
      const names = await tenantNames(invoices.map(invoice => invoice.tenantId));
      const rows = invoices.map(invoice => ({ tenant: names.get(invoice.tenantId) ?? 'Cliente removido', reference: invoice.reference, dueDate: invoice.dueDate, days: Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86_400_000), total: invoice.total }));
      return { columns: [{ key: 'tenant', label: 'Cliente', type: 'text' }, { key: 'reference', label: 'Referência', type: 'text' }, { key: 'dueDate', label: 'Vencimento', type: 'datetime' }, { key: 'days', label: 'Dias em atraso', type: 'number' }, { key: 'total', label: 'Valor', type: 'money' }], rows, totals: { total: sumDecimals(rows.map(row => row.total)) } };
    },
  },
  'coupons-used': {
    title: 'Cupons utilizados', description: 'Resgates de cupons no período, por cupom.',
    build: async ({ from, to }) => {
      const redemptions = await prisma.saaSCouponRedemption.findMany({ where: { couponId: { not: null }, createdAt: { gte: from, lte: to } }, select: { amount: true, tenantId: true, coupon: { select: { code: true, name: true } } } });
      const groups = new Map<string, { code: string; name: string; uses: number; tenants: Set<string>; amount: Prisma.Decimal }>();
      for (const redemption of redemptions) {
        const key = redemption.coupon?.code ?? 'removido';
        const group = groups.get(key) ?? { code: key, name: redemption.coupon?.name ?? '—', uses: 0, tenants: new Set<string>(), amount: D(0) };
        group.uses += 1; group.tenants.add(redemption.tenantId); group.amount = group.amount.add(redemption.amount); groups.set(key, group);
      }
      const rows = [...groups.values()].map(group => ({ code: group.code, name: group.name, uses: group.uses, tenants: group.tenants.size, amount: group.amount })).sort((a, b) => b.uses - a.uses);
      return { columns: [{ key: 'code', label: 'Cupom', type: 'text' }, { key: 'name', label: 'Nome', type: 'text' }, { key: 'uses', label: 'Usos', type: 'number' }, { key: 'tenants', label: 'Clientes', type: 'number' }, { key: 'amount', label: 'Desconto concedido', type: 'money' }], rows, totals: { uses: rows.reduce((sum, row) => sum + row.uses, 0), amount: sumDecimals(rows.map(row => row.amount)) } };
    },
  },
  'promotions-result': {
    title: 'Resultado das promoções', description: 'Uso e desconto concedido por promoção no período.',
    build: async ({ from, to }) => {
      const [campaigns, redemptions] = await Promise.all([prisma.saaSCampaign.findMany({ select: { id: true, name: true, status: true, startsAt: true, endsAt: true } }), prisma.saaSCouponRedemption.findMany({ where: { campaignId: { not: null }, createdAt: { gte: from, lte: to } }, select: { campaignId: true, amount: true, tenantId: true } })]);
      const rows = campaigns.map(campaign => {
        const own = redemptions.filter(redemption => redemption.campaignId === campaign.id);
        return { name: campaign.name, status: campaign.status, startsAt: campaign.startsAt, endsAt: campaign.endsAt, uses: own.length, tenants: new Set(own.map(item => item.tenantId)).size, amount: sumDecimals(own.map(item => item.amount)) };
      }).sort((a, b) => b.uses - a.uses);
      return { columns: [{ key: 'name', label: 'Promoção', type: 'text' }, { key: 'status', label: 'Situação', type: 'text' }, { key: 'startsAt', label: 'Início', type: 'datetime' }, { key: 'endsAt', label: 'Término', type: 'datetime' }, { key: 'uses', label: 'Usos', type: 'number' }, { key: 'tenants', label: 'Clientes', type: 'number' }, { key: 'amount', label: 'Desconto concedido', type: 'money' }], rows, totals: { uses: rows.reduce((sum, row) => sum + row.uses, 0), amount: sumDecimals(rows.map(row => row.amount)) } };
    },
  },
  discounts: {
    title: 'Descontos concedidos', description: 'Cobranças do período com desconto, cupom ou promoção.',
    build: async ({ from, to }) => {
      const invoices = await prisma.saaSInvoice.findMany({ where: { status: { not: 'CANCELLED' }, discount: { gt: 0 }, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, take: 5000, select: { tenantId: true, reference: true, createdAt: true, subtotal: true, discount: true, total: true, coupon: { select: { code: true } }, campaign: { select: { name: true } } } });
      const names = await tenantNames(invoices.map(invoice => invoice.tenantId));
      const rows = invoices.map(invoice => ({ createdAt: invoice.createdAt, tenant: names.get(invoice.tenantId) ?? 'Cliente removido', reference: invoice.reference, origin: invoice.coupon ? `Cupom ${invoice.coupon.code}` : invoice.campaign ? `Promoção ${invoice.campaign.name}` : 'Desconto negociado', subtotal: invoice.subtotal, discount: invoice.discount, total: invoice.total }));
      return { columns: [{ key: 'createdAt', label: 'Data', type: 'datetime' }, { key: 'tenant', label: 'Cliente', type: 'text' }, { key: 'reference', label: 'Referência', type: 'text' }, { key: 'origin', label: 'Origem', type: 'text' }, { key: 'subtotal', label: 'Subtotal', type: 'money' }, { key: 'discount', label: 'Desconto', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }], rows, totals: { subtotal: sumDecimals(rows.map(row => row.subtotal)), discount: sumDecimals(rows.map(row => row.discount)), total: sumDecimals(rows.map(row => row.total)) } };
    },
  },
  'revenue-evolution': {
    title: 'Evolução da receita recebida', description: 'Cobranças pagas por mês (resultado efetivo, não é estimativa de MRR).',
    build: async ({ from, to }) => {
      const invoices = await prisma.saaSInvoice.findMany({ where: { status: 'PAID', paidAt: { gte: from, lte: to } }, select: { total: true, paidAt: true } });
      const groups = new Map<string, { month: string; invoices: number; received: Prisma.Decimal }>();
      for (const invoice of invoices) {
        const key = monthKey(invoice.paidAt!);
        const group = groups.get(key) ?? { month: key, invoices: 0, received: D(0) };
        group.invoices += 1; group.received = group.received.add(invoice.total); groups.set(key, group);
      }
      const rows = [...groups.values()].sort((a, b) => a.month.localeCompare(b.month)).map(group => ({ ...group, month: `${group.month.slice(5)}/${group.month.slice(0, 4)}` }));
      return { columns: [{ key: 'month', label: 'Mês', type: 'text' }, { key: 'invoices', label: 'Cobranças pagas', type: 'number' }, { key: 'received', label: 'Recebido', type: 'money' }], rows, totals: { invoices: rows.reduce((sum, row) => sum + row.invoices, 0), received: sumDecimals(rows.map(row => row.received)) } };
    },
  },
  'plan-changes': {
    title: 'Upgrades e downgrades', description: 'Trocas de plano registradas na auditoria, com valores anterior e novo.',
    build: async ({ from, to }) => {
      const logs = await prisma.auditLog.findMany({ where: { action: 'SUBSCRIPTION_PLAN_CHANGED', createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, take: 5000, select: { createdAt: true, tenantId: true, actorUserId: true, metadata: true } });
      const names = await tenantNames(logs.flatMap(log => (log.tenantId ? [log.tenantId] : [])));
      const label: Record<string, string> = { UPGRADE: 'Upgrade', DOWNGRADE: 'Downgrade', CHANGE: 'Troca' };
      const rows = logs.map(log => {
        const meta = (log.metadata ?? {}) as { direction?: string; from?: { name?: string | null; price?: string | null }; to?: { name?: string | null; price?: string | null }; reason?: string | null };
        return { at: log.createdAt, tenant: log.tenantId ? names.get(log.tenantId) ?? 'Cliente removido' : '—', direction: label[meta.direction ?? ''] ?? text(meta.direction), from: text(meta.from?.name), fromPrice: meta.from?.price ?? null, to: text(meta.to?.name), toPrice: meta.to?.price ?? null, reason: text(meta.reason) };
      });
      return { columns: [{ key: 'at', label: 'Data', type: 'datetime' }, { key: 'tenant', label: 'Cliente', type: 'text' }, { key: 'direction', label: 'Tipo', type: 'text' }, { key: 'from', label: 'Plano anterior', type: 'text' }, { key: 'fromPrice', label: 'Valor anterior', type: 'money' }, { key: 'to', label: 'Novo plano', type: 'text' }, { key: 'toPrice', label: 'Novo valor', type: 'money' }, { key: 'reason', label: 'Motivo', type: 'text' }], rows };
    },
  },
};

commercialReportsRoutes.get('/', (_req, res) => res.json({ items: Object.entries(REPORTS).map(([kind, { title, description }]) => ({ kind, title, description })) }));

commercialReportsRoutes.get('/:kind', async (req: Request, res, next) => {
  try {
    const definition = Object.hasOwn(REPORTS, req.params.kind) ? REPORTS[req.params.kind] : undefined;
    if (!definition) return res.status(404).json({ message: 'Report not found' });
    const now = new Date();
    const period = req.query.from === undefined && req.query.to === undefined ? { from: new Date(now.getTime() - 90 * 86_400_000), to: now } : parsePeriod(req.query);
    if (!period) return res.status(400).json({ message: 'Invalid date range' });
    const report = finalizeReport(req.params.kind, period, await definition.build({ ...period, now: new Date() }));
    const format = req.query.format;
    if (!isExportFormat(format)) return res.json(report);
    res.setHeader('Content-Type', EXPORT_FORMATS[format]);
    res.setHeader('Content-Disposition', `attachment; filename="comercial-${req.params.kind}.${format}"`);
    if (format === 'csv') return res.send(reportToCsv(report, TIME_ZONE));
    const options = { timeZone: TIME_ZONE, title: definition.title, headerLines: ['RM Agência de TI — RM Painel Admin'] };
    return res.send(format === 'xlsx' ? reportToXlsx(report, options) : reportToPdf(report, options));
  } catch (error) { return next(error); }
});
