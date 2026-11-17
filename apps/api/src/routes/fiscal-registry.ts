import { Router, type Request, type Response } from 'express';
import { FiscalStatus, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { activeFilter, audit, isUniqueViolation, listQuerySchema, optionalText, unitReadScope, validationError } from '../lib/registry';
import { isValidAccessKey, parseNfeXml } from '../lib/nfe-xml';

/**
 * Fiscal/Tributos auxiliares: naturezas de operação, correlação de CST, notas recebidas (entrada de NF-e), contingência e conciliação.
 * Tudo aqui é cadastro e conferência local: nada é transmitido à SEFAZ nem validado contra a legislação ou a assinatura do XML.
 */
export const fiscalRegistryRoutes = Router();
fiscalRegistryRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
const manage = requireRoles(...MANAGEMENT_ROLES);
const tenantOf = (req: Request) => req.auth!.tenantId!;
const unitWrite = (req: Request) => req.auth!.unitId ?? null;
const notFound = (res: Response, label: string) => res.status(404).json({ message: `${label} não encontrada.` });

const cfop = z.string().trim().regex(/^\d{4}$/, 'CFOP deve ter 4 dígitos');
const cst = z.string().trim().regex(/^\d{2,3}$/, 'CST/CSOSN deve ter 2 ou 3 dígitos');

// ---- Naturezas de operação ----
const natureSchema = z.object({
  name: z.string().trim().min(2).max(120), cfop, direction: z.enum(['IN', 'OUT']).default('OUT'),
  finality: z.enum(['NORMAL', 'COMPLEMENTARY', 'ADJUSTMENT', 'RETURN']).default('NORMAL'), description: optionalText(255), active: z.boolean().default(true),
});
const natureConflict = { message: 'Já existe uma natureza de operação com esse nome.' };

fiscalRegistryRoutes.get('/natures', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const items = await prisma.operationNature.findMany({ where: { tenantId: tenantOf(req), ...activeFilter(active), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { cfop: { contains: q } }] } : {}) }, orderBy: { name: 'asc' } });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
fiscalRegistryRoutes.post('/natures', manage, async (req, res, next) => {
  try {
    const parsed = natureSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    if (await prisma.operationNature.findFirst({ where: { tenantId: tenantOf(req), name: { equals: parsed.data.name, mode: 'insensitive' } }, select: { id: true } })) return res.status(409).json(natureConflict);
    const created = await prisma.operationNature.create({ data: { ...parsed.data, tenantId: tenantOf(req) } });
    await audit(req, 'OPERATION_NATURE_CREATED', 'OperationNature', created.id);
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(natureConflict) : next(error); }
});
fiscalRegistryRoutes.patch('/natures/:id', manage, async (req, res, next) => {
  try {
    const parsed = natureSchema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.operationNature.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) }, select: { id: true } }); if (!current) return notFound(res, 'Natureza de operação');
    if (parsed.data.name && await prisma.operationNature.findFirst({ where: { tenantId: tenantOf(req), id: { not: current.id }, name: { equals: parsed.data.name, mode: 'insensitive' } }, select: { id: true } })) return res.status(409).json(natureConflict);
    const updated = await prisma.operationNature.update({ where: { id: current.id }, data: parsed.data });
    await audit(req, 'OPERATION_NATURE_UPDATED', 'OperationNature', current.id);
    return res.json(updated);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(natureConflict) : next(error); }
});
// Natures used by received invoices are deactivated instead of deleted.
fiscalRegistryRoutes.delete('/natures/:id', manage, async (req, res, next) => {
  try {
    const current = await prisma.operationNature.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) }, select: { id: true } }); if (!current) return notFound(res, 'Natureza de operação');
    if (await prisma.receivedInvoice.count({ where: { natureId: current.id } }) > 0) {
      await prisma.operationNature.update({ where: { id: current.id }, data: { active: false } });
      await audit(req, 'OPERATION_NATURE_DEACTIVATED', 'OperationNature', current.id);
      return res.json({ deleted: false, deactivated: true });
    }
    await prisma.operationNature.delete({ where: { id: current.id } });
    await audit(req, 'OPERATION_NATURE_DELETED', 'OperationNature', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});

// ---- Correlação CST ICMS de saída x entrada ----
const cstSchema = z.object({ outCst: cst, inCst: cst, description: optionalText(255), active: z.boolean().default(true) });
const cstConflict = { message: 'Já existe uma correlação para esse CST de saída.' };

fiscalRegistryRoutes.get('/cst-map', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const items = await prisma.cstCorrelation.findMany({ where: { tenantId: tenantOf(req), ...activeFilter(active), ...(q ? { OR: [{ outCst: { contains: q } }, { inCst: { contains: q } }, { description: { contains: q, mode: 'insensitive' } }] } : {}) }, orderBy: { outCst: 'asc' } });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
fiscalRegistryRoutes.post('/cst-map', manage, async (req, res, next) => {
  try {
    const parsed = cstSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const created = await prisma.cstCorrelation.create({ data: { ...parsed.data, tenantId: tenantOf(req) } });
    await audit(req, 'CST_CORRELATION_CREATED', 'CstCorrelation', created.id);
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(cstConflict) : next(error); }
});
fiscalRegistryRoutes.patch('/cst-map/:id', manage, async (req, res, next) => {
  try {
    const parsed = cstSchema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.cstCorrelation.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) }, select: { id: true } }); if (!current) return notFound(res, 'Correlação');
    const updated = await prisma.cstCorrelation.update({ where: { id: current.id }, data: parsed.data });
    await audit(req, 'CST_CORRELATION_UPDATED', 'CstCorrelation', current.id);
    return res.json(updated);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(cstConflict) : next(error); }
});
fiscalRegistryRoutes.delete('/cst-map/:id', manage, async (req, res, next) => {
  try {
    const current = await prisma.cstCorrelation.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) }, select: { id: true } }); if (!current) return notFound(res, 'Correlação');
    await prisma.cstCorrelation.delete({ where: { id: current.id } });
    await audit(req, 'CST_CORRELATION_DELETED', 'CstCorrelation', current.id);
    return res.json({ deleted: true });
  } catch (error) { return next(error); }
});

// ---- Notas recebidas / entrada de NF-e ----
const itemSchema = z.object({
  description: z.string().trim().min(1).max(200), ncm: optionalText(8), cfop: optionalText(4),
  quantity: z.number().finite().positive().max(1_000_000), unitValue: z.number().finite().min(0).max(10_000_000), totalValue: z.number().finite().min(0).max(100_000_000),
});
const invoiceSchema = z.object({
  accessKey: z.string().trim().refine(isValidAccessKey, 'Chave de acesso inválida (44 dígitos com dígito verificador correto)'),
  number: z.string().trim().min(1).max(20), series: z.string().trim().min(1).max(5).default('1'),
  supplierName: z.string().trim().min(2).max(160), supplierDocument: z.string().trim().nullish().transform(value => (value ?? '').replace(/\D/g, '') || null).refine(value => value === null || [11, 14].includes(value.length), 'Documento do emitente deve ter 11 ou 14 dígitos'),
  issuedAt: z.coerce.date(), totalAmount: z.number().finite().min(0).max(1_000_000_000), natureId: z.string().uuid().nullish(),
  items: z.array(itemSchema).max(500).default([]), notes: optionalText(500), xml: z.string().max(500_000).nullish(),
});
const xmlSchema = z.object({ xml: z.string().min(50).max(500_000) });
const periodSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const invoiceListSchema = periodSchema.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['RECEIVED', 'ENTERED', 'CANCELLED']).optional() });
const invoiceSelect = { id: true, accessKey: true, number: true, series: true, supplierName: true, supplierDocument: true, issuedAt: true, totalAmount: true, status: true, enteredAt: true, notes: true, createdAt: true, items: true, nature: { select: { id: true, name: true, cfop: true } } } satisfies Prisma.ReceivedInvoiceSelect;
const invoiceScope = (req: Request, id?: string) => ({ tenantId: tenantOf(req), ...(id ? { id } : {}), ...unitReadScope(req) });

fiscalRegistryRoutes.get('/invoices', async (req, res, next) => {
  try {
    const query = invoiceListSchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, status, from, to } = query.data;
    const search = q ? { OR: [{ supplierName: { contains: q, mode: 'insensitive' as const } }, { number: { contains: q } }, { accessKey: { contains: q.replace(/\D/g, '') || '\u0000' } }] } : {};
    const items = await prisma.receivedInvoice.findMany({ where: { ...invoiceScope(req), ...(status ? { status } : {}), ...(from || to ? { issuedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}), ...(q ? { AND: [search] } : {}) }, select: { ...invoiceSelect, xml: false }, orderBy: { issuedAt: 'desc' }, take: 300 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
fiscalRegistryRoutes.post('/invoices/parse-xml', async (req, res) => {
  const parsed = xmlSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
  try { return res.json(parseNfeXml(parsed.data.xml)); } catch (error) { return res.status(422).json({ message: error instanceof Error ? error.message : 'XML inválido.' }); }
});
fiscalRegistryRoutes.post('/invoices', async (req, res, next) => {
  try {
    const parsed = invoiceSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = tenantOf(req);
    if (parsed.data.natureId && !await prisma.operationNature.findFirst({ where: { id: parsed.data.natureId, tenantId }, select: { id: true } })) return res.status(400).json({ message: 'Natureza de operação inválida.' });
    if (parsed.data.xml) {
      // The stored XML must belong to the same note, otherwise the file could be used to attach a foreign document.
      try { if (parseNfeXml(parsed.data.xml).accessKey !== parsed.data.accessKey) return res.status(400).json({ message: 'O XML anexado pertence a outra chave de acesso.' }); }
      catch (error) { return res.status(422).json({ message: error instanceof Error ? error.message : 'XML inválido.' }); }
    }
    const { xml, ...data } = parsed.data;
    const created = await prisma.receivedInvoice.create({ data: { ...data, xml: xml ?? null, tenantId, unitId: unitWrite(req) }, select: invoiceSelect });
    await audit(req, 'RECEIVED_INVOICE_CREATED', 'ReceivedInvoice', created.id, { accessKey: created.accessKey });
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json({ message: 'Esta nota (chave de acesso) já foi registrada.' }) : next(error); }
});
fiscalRegistryRoutes.get('/invoices/:id/xml', async (req, res, next) => {
  try {
    const invoice = await prisma.receivedInvoice.findFirst({ where: invoiceScope(req, req.params.id), select: { accessKey: true, xml: true } }); if (!invoice) return notFound(res, 'Nota');
    if (!invoice.xml) return res.status(404).json({ message: 'Esta nota foi lançada sem XML.' });
    return res.json({ accessKey: invoice.accessKey, xml: invoice.xml });
  } catch (error) { return next(error); }
});
// Status moves only forward from RECEIVED; an entered note is final. Stock and payables are still posted in Compras/Financeiro.
async function transition(req: Request, res: Response, next: (error: unknown) => void, status: 'ENTERED' | 'CANCELLED') {
  try {
    const current = await prisma.receivedInvoice.findFirst({ where: invoiceScope(req, req.params.id), select: { id: true } }); if (!current) return notFound(res, 'Nota');
    const result = await prisma.receivedInvoice.updateMany({ where: { id: current.id, status: 'RECEIVED' }, data: { status, ...(status === 'ENTERED' ? { enteredAt: new Date() } : {}) } });
    if (result.count === 0) return res.status(409).json({ message: 'Só notas com status Recebida podem ser alteradas.' });
    await audit(req, status === 'ENTERED' ? 'RECEIVED_INVOICE_ENTERED' : 'RECEIVED_INVOICE_CANCELLED', 'ReceivedInvoice', current.id);
    return res.json(await prisma.receivedInvoice.findUnique({ where: { id: current.id }, select: { ...invoiceSelect, xml: false } }));
  } catch (error) { return next(error); }
}
fiscalRegistryRoutes.post('/invoices/:id/enter', (req, res, next) => transition(req, res, next, 'ENTERED'));
fiscalRegistryRoutes.post('/invoices/:id/cancel', manage, (req, res, next) => transition(req, res, next, 'CANCELLED'));

// ---- XMLs: recebidos (armazenados) e emitidos (link do provedor) ----
fiscalRegistryRoutes.get('/xmls', async (req, res, next) => {
  try {
    const query = periodSchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { from, to } = query.data; const tenantId = tenantOf(req);
    const range = (field: 'issuedAt' | 'createdAt') => (from || to ? { [field]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {});
    const [received, emitted] = await Promise.all([
      prisma.receivedInvoice.findMany({ where: { ...invoiceScope(req), xml: { not: null }, ...range('issuedAt') }, select: { id: true, accessKey: true, number: true, supplierName: true, issuedAt: true, totalAmount: true, status: true }, orderBy: { issuedAt: 'desc' }, take: 300 }),
      prisma.fiscalDocument.findMany({ where: { tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: [FiscalStatus.AUTHORIZED, FiscalStatus.CANCELLED] }, ...range('createdAt') }, select: { id: true, kind: true, status: true, number: true, accessKey: true, documentUrl: true, createdAt: true, order: { select: { code: true, total: true } } }, orderBy: { createdAt: 'desc' }, take: 300 }),
    ]);
    return res.json({ received, emitted });
  } catch (error) { return next(error); }
});

// ---- Contingência ----
// Records the contingency period: while active, NFC-e communication failures are kept as CONTINGENCY documents for later transmission
// (POST /fiscal/documents/transmit) and the provider is asked to use its offline modality.
fiscalRegistryRoutes.get('/contingency', async (req, res, next) => {
  try {
    const tenantId = tenantOf(req);
    const [history, pending] = await Promise.all([
      prisma.fiscalContingency.findMany({ where: { tenantId }, orderBy: { startedAt: 'desc' }, take: 30 }),
      prisma.fiscalDocument.findMany({ where: { tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: [FiscalStatus.PENDING, FiscalStatus.REJECTED, FiscalStatus.PROCESSING, FiscalStatus.CONTINGENCY] } }, select: { id: true, kind: true, status: true, error: true, createdAt: true, number: true, series: true, environment: true, protocol: true, contingency: true, lastAttemptAt: true, attempts: true, order: { select: { code: true, total: true, customerName: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);
    return res.json({ active: history.find(item => item.endedAt === null) ?? null, history, pending });
  } catch (error) { return next(error); }
});
fiscalRegistryRoutes.post('/contingency/start', manage, async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().min(15, 'Informe o motivo (mínimo 15 caracteres)').max(255) }).safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = tenantOf(req);
    const created = await prisma.$transaction(async tx => {
      if (await tx.fiscalContingency.findFirst({ where: { tenantId, endedAt: null }, select: { id: true } })) return null;
      return tx.fiscalContingency.create({ data: { tenantId, reason: parsed.data.reason, startedById: req.auth!.userId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(() => null);
    if (!created) return res.status(409).json({ message: 'Já existe uma contingência em andamento.' });
    await audit(req, 'FISCAL_CONTINGENCY_STARTED', 'FiscalContingency', created.id);
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});
fiscalRegistryRoutes.post('/contingency/end', manage, async (req, res, next) => {
  try {
    const current = await prisma.fiscalContingency.findFirst({ where: { tenantId: tenantOf(req), endedAt: null } });
    const closed = current ? await prisma.fiscalContingency.updateMany({ where: { id: current.id, endedAt: null }, data: { endedAt: new Date(), endedById: req.auth!.userId } }) : null;
    if (!current || !closed || closed.count === 0) return res.status(409).json({ message: 'Não há contingência em andamento.' });
    await audit(req, 'FISCAL_CONTINGENCY_ENDED', 'FiscalContingency', current.id);
    return res.json(await prisma.fiscalContingency.findUnique({ where: { id: current.id } }));
  } catch (error) { return next(error); }
});

// ---- Conciliação tributária: pedidos concluídos x documentos fiscais ----
fiscalRegistryRoutes.get('/reconciliation', async (req, res, next) => {
  try {
    const query = periodSchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const to = query.data.to ?? new Date(); const from = query.data.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const tenantId = tenantOf(req); const unitFilter = req.auth!.unitId ? { unitId: req.auth!.unitId } : {};
    const orderWhere = { tenantId, ...unitFilter, status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } };
    const [orders, documents, received] = await Promise.all([
      prisma.order.findMany({ where: orderWhere, select: { id: true, code: true, total: true, createdAt: true, fiscalDocuments: { select: { status: true } } }, orderBy: { createdAt: 'desc' }, take: 5000 }),
      prisma.fiscalDocument.groupBy({ by: ['status'], where: { tenantId, ...unitFilter, createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
      prisma.receivedInvoice.groupBy({ by: ['status'], where: { tenantId, ...unitReadScope(req), issuedAt: { gte: from, lte: to } }, _count: { _all: true }, _sum: { totalAmount: true } }),
    ]);
    const cents = (value: Prisma.Decimal) => Math.round(Number(value) * 100);
    const authorized = (order: typeof orders[number]) => order.fiscalDocuments.some(doc => doc.status === FiscalStatus.AUTHORIZED);
    const withoutDocument = orders.filter(order => !authorized(order));
    const totalCents = orders.reduce((sum, order) => sum + cents(order.total), 0);
    const missingCents = withoutDocument.reduce((sum, order) => sum + cents(order.total), 0);
    return res.json({
      from, to, truncated: orders.length === 5000,
      orders: { count: orders.length, total: totalCents / 100 },
      invoiced: { count: orders.length - withoutDocument.length, total: (totalCents - missingCents) / 100 },
      withoutDocument: { count: withoutDocument.length, total: missingCents / 100, items: withoutDocument.slice(0, 200).map(order => ({ id: order.id, code: order.code, total: order.total, createdAt: order.createdAt })) },
      documentsByStatus: Object.fromEntries(documents.map(row => [row.status, row._count._all])),
      receivedByStatus: Object.fromEntries(received.map(row => [row.status, { count: row._count._all, total: Number(row._sum.totalAmount ?? 0) }])),
    });
  } catch (error) { return next(error); }
});
