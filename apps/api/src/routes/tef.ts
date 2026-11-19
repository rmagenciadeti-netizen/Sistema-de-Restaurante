import { Router } from 'express';
import { Prisma, TefIntegrationStatus, TefStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { CASH_ROLES, FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { requireAuth, requireTenant } from '../middleware/auth';
import { openSecret, sealSecret } from '../lib/fiscal-config';
import { tefAdapters, type TefAdapter } from '../lib/tef/adapter';
import { autoPrintTefReceipt } from '../lib/receipts';
import { emitAfterPayment, type AfterPaymentResult } from '../lib/fiscal-service';
import { configView, loadTransaction, monitor, recoverInFlight, reconcile, reverseTransaction, startTransaction, syncTransaction, TefError, undoTransaction } from '../lib/tef/service';
import { positiveMoneySchema } from '../lib/money';

export const tefRoutes = Router();
tefRoutes.use(requireAuth, requireTenant);

const unitOf = (req: { auth?: { unitId?: string | null } }) => req.auth!.unitId ?? null;
const handle = (res: import('express').Response, next: import('express').NextFunction, error: unknown) => error instanceof TefError ? res.status(error.status).json({ message: error.message, code: error.code }) : next(error);

function publicConfig(adapter: TefAdapter, row: Awaited<ReturnType<typeof prisma.tefProviderConfig.findFirst>>) {
  let stored: Record<string, string> = {};
  if (row?.credentialsEnc) { try { stored = JSON.parse(openSecret(row.credentialsEnc).toString('utf8')); } catch { stored = {}; } }
  const secretKeys = adapter.fields.filter(field => field.secret).map(field => field.key);
  return {
    provider: adapter.name, label: adapter.label, simulated: adapter.simulated, capabilities: adapter.capabilities,
    // Only the fields that apply to this provider are sent to the screen.
    fields: adapter.fields,
    integrationStatus: row?.integrationStatus ?? TefIntegrationStatus.NOT_CONFIGURED, environment: row?.environment ?? 'HOMOLOGATION',
    establishmentCnpj: row?.establishmentCnpj ?? '', merchantCode: row?.merchantCode ?? '', logicalNumber: row?.logicalNumber ?? '', terminalId: row?.terminalId ?? '', cashRegisterId: row?.cashRegisterId ?? '', pinpad: row?.pinpad ?? '',
    connection: row?.connection ?? {}, printing: row?.printing ?? {}, enabledMethods: row?.enabledMethods ?? [], acceptedBrands: row?.acceptedBrands ?? [], financialMapping: row?.financialMapping ?? {},
    homologationEvidence: row?.homologationEvidence ?? '', lastTest: row?.lastTestAt ? { at: row.lastTestAt, ok: row.lastTestOk, message: row.lastTestMessage } : null,
    // Secrets are never returned: only whether each one is filled.
    credentials: Object.fromEntries(adapter.fields.filter(field => field.secret).map(field => [field.key, Boolean(stored[field.key]) ])), secretKeys,
  };
}

tefRoutes.get('/providers', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const rows = await prisma.tefProviderConfig.findMany({ where: { tenantId: req.auth!.tenantId! } });
    const byProvider = new Map(rows.map(row => [row.provider, row]));
    return res.json({ items: tefAdapters.all().map(adapter => publicConfig(adapter, byProvider.get(adapter.name) ?? null)), registered: tefAdapters.all().length });
  } catch (error) { return next(error); }
});

const configSchema = z.object({
  environment: z.enum(['HOMOLOGATION', 'PRODUCTION']).default('HOMOLOGATION'),
  establishmentCnpj: z.string().trim().transform(value => value.replace(/\D/g, '')).refine(value => value === '' || value.length === 14, 'CNPJ com 14 dígitos').default(''),
  merchantCode: z.string().trim().max(60).default(''), logicalNumber: z.string().trim().max(60).default(''), terminalId: z.string().trim().max(60).default(''), cashRegisterId: z.string().trim().max(60).default(''), pinpad: z.string().trim().max(120).default(''),
  connection: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()])).default({}),
  credentials: z.record(z.string().max(60), z.string().max(4000)).default({}), clearCredentials: z.array(z.string().max(60)).max(20).default([]),
  printing: z.object({ autoPrint: z.boolean().default(false), copies: z.number().int().min(1).max(3).default(1), paper: z.enum(['58mm', '80mm', 'A4']).default('80mm'), allowReprint: z.boolean().default(true) }).default({ autoPrint: false, copies: 1, paper: '80mm', allowReprint: true }),
  enabledMethods: z.array(z.enum(['CREDIT_CARD', 'DEBIT_CARD', 'PIX', 'VOUCHER'])).max(4).default([]), acceptedBrands: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  financialMapping: z.record(z.string().max(30), z.string().max(80)).default({}),
  integrationStatus: z.nativeEnum(TefIntegrationStatus).optional(), homologationEvidence: z.string().trim().max(2000).default(''),
});

tefRoutes.put('/config/:provider', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const adapter = tefAdapters.get(req.params.provider);
    if (!adapter) return res.status(404).json({ message: 'Provedor TEF não disponível neste servidor.' });
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Validation failed', errors: parsed.error.flatten() });
    const body = parsed.data; const tenantId = req.auth!.tenantId!;
    const secretKeys = new Set(adapter.fields.filter(field => field.secret).map(field => field.key));
    const plainKeys = new Set(adapter.fields.filter(field => !field.secret).map(field => field.key));
    const badCredential = Object.keys(body.credentials).find(key => !secretKeys.has(key)); if (badCredential) return res.status(400).json({ message: `Campo de credencial não existe neste provedor: ${badCredential}` });
    const badConnection = Object.keys(body.connection).find(key => !plainKeys.has(key)); if (badConnection) return res.status(400).json({ message: `Parâmetro não existe neste provedor: ${badConnection}` });
    const row = await prisma.tefProviderConfig.findUnique({ where: { tenantId_provider: { tenantId, provider: adapter.name } } });
    let stored: Record<string, string> = {};
    if (row?.credentialsEnc) stored = JSON.parse(openSecret(row.credentialsEnc).toString('utf8'));
    for (const key of body.clearCredentials) delete stored[key];
    for (const [key, value] of Object.entries(body.credentials)) if (value.trim() !== '') stored[key] = value;
    const missingRequired = adapter.fields.filter(field => field.required && (field.secret ? !stored[field.key] : String(body.connection[field.key] ?? '').trim() === ''));
    const previous = row?.integrationStatus ?? TefIntegrationStatus.NOT_CONFIGURED;
    let status = body.integrationStatus ?? previous;
    if (!body.integrationStatus && (['NOT_CONFIGURED', 'AWAITING_CREDENTIALS', 'CONFIGURED'] as TefIntegrationStatus[]).includes(previous)) status = missingRequired.length > 0 || !body.establishmentCnpj ? TefIntegrationStatus.AWAITING_CREDENTIALS : TefIntegrationStatus.CONFIGURED;
    if ((['HOMOLOGATED', 'PRODUCTION_ENABLED'] as TefIntegrationStatus[]).includes(status)) {
      if (adapter.simulated) return res.status(409).json({ message: 'O simulador nunca pode ser marcado como homologado.' });
      if (req.auth!.role !== UserRole.ADMIN && status !== previous) return res.status(403).json({ message: 'Somente o administrador pode marcar a integração como homologada ou liberar a produção.' });
      if (status === TefIntegrationStatus.HOMOLOGATED && (body.homologationEvidence.length < 10 || row?.lastTestOk !== true)) return res.status(409).json({ message: 'Para marcar como homologado, registre a evidência da homologação (mín. 10 caracteres) e tenha um teste de comunicação bem-sucedido.' });
      if (status === TefIntegrationStatus.PRODUCTION_ENABLED && (previous !== TefIntegrationStatus.HOMOLOGATED && previous !== TefIntegrationStatus.PRODUCTION_ENABLED || body.environment !== 'PRODUCTION')) return res.status(409).json({ message: 'A produção só pode ser habilitada para um provedor já homologado e com ambiente de produção.' });
    } else if (status === TefIntegrationStatus.IN_TESTING && missingRequired.length > 0) return res.status(409).json({ message: `Preencha os campos obrigatórios: ${missingRequired.map(field => field.label).join(', ')}.` });
    const data = {
      environment: body.environment, integrationStatus: status, establishmentCnpj: body.establishmentCnpj || null, merchantCode: body.merchantCode || null, logicalNumber: body.logicalNumber || null, terminalId: body.terminalId || null, cashRegisterId: body.cashRegisterId || null, pinpad: body.pinpad || null,
      connection: body.connection as Prisma.InputJsonValue, credentialsEnc: Object.keys(stored).length > 0 ? sealSecret(JSON.stringify(stored)) : null, printing: body.printing as Prisma.InputJsonValue, enabledMethods: body.enabledMethods, acceptedBrands: body.acceptedBrands,
      financialMapping: body.financialMapping as Prisma.InputJsonValue, homologationEvidence: body.homologationEvidence || null,
    };
    const saved = await prisma.$transaction(async tx => {
      const result = await tx.tefProviderConfig.upsert({ where: { tenantId_provider: { tenantId, provider: adapter.name } }, create: { tenantId, provider: adapter.name, ...data }, update: data });
      // The audit trail records what changed, never the secret values.
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'TEF_CONFIG_UPDATED', entityType: 'TefProviderConfig', entityId: result.id, metadata: { provider: adapter.name, previousStatus: previous, status, environment: body.environment, credentialsChanged: Object.keys(body.credentials).concat(body.clearCredentials) } } });
      return result;
    });
    return res.json(publicConfig(adapter, saved));
  } catch (error) { return next(error); }
});

tefRoutes.post('/config/:provider/test', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const adapter = tefAdapters.get(req.params.provider);
    const tenantId = req.auth!.tenantId!;
    const row = adapter ? await prisma.tefProviderConfig.findUnique({ where: { tenantId_provider: { tenantId, provider: adapter.name } } }) : null;
    if (!adapter || !row) return res.status(404).json({ message: 'Configure o provedor antes de testar a comunicação.' });
    let result: { ok: boolean; message: string };
    try { result = await adapter.testConnection(configView(row)); } catch (error) { result = { ok: false, message: error instanceof TefError ? error.message : 'Falha de comunicação com o provedor.' }; }
    const status = result.ok
      ? (([TefIntegrationStatus.CONFIGURED, TefIntegrationStatus.FAILED] as TefIntegrationStatus[]).includes(row.integrationStatus) ? TefIntegrationStatus.IN_TESTING : row.integrationStatus)
      : (([TefIntegrationStatus.CONFIGURED, TefIntegrationStatus.IN_TESTING] as TefIntegrationStatus[]).includes(row.integrationStatus) ? TefIntegrationStatus.FAILED : row.integrationStatus);
    await prisma.tefProviderConfig.update({ where: { id: row.id }, data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message.slice(0, 300), integrationStatus: status } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'TEF_CONNECTION_TESTED', entityType: 'TefProviderConfig', entityId: row.id, metadata: { provider: adapter.name, ok: result.ok } } });
    return res.json({ ...result, integrationStatus: status });
  } catch (error) { return next(error); }
});

// ---- Transactions ----
const startSchema = z.object({
  orderId: z.string().uuid(), provider: z.string().min(1).max(60), method: z.enum(['CREDIT_CARD', 'DEBIT_CARD', 'PIX', 'VOUCHER']), amount: positiveMoneySchema, installments: z.number().int().min(1).max(24).default(1),
  idempotencyKey: z.string().trim().min(8).max(100), cashSessionId: z.string().uuid().optional(), hints: z.record(z.string().max(30), z.string().max(30)).optional(),
});

tefRoutes.post('/transactions', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, unitId, userId } = req.auth!;
    const { transaction, replayed } = await startTransaction({ tenantId: tenantId!, unitId: unitId ?? null, userId, orderId: parsed.data.orderId, provider: parsed.data.provider, method: parsed.data.method, amount: new Prisma.Decimal(parsed.data.amount), installments: parsed.data.installments, idempotencyKey: parsed.data.idempotencyKey, cashSessionId: parsed.data.cashSessionId, hints: parsed.data.hints });
    await autoPrintTefReceipt(transaction, userId);
    // Only an APPROVED transaction is a paid sale; the screen must treat every other status as not paid.
    return res.status(replayed ? 200 : 201).json({ transaction: view(transaction), paid: transaction.status === TefStatus.APPROVED, replayed });
  } catch (error) { return handle(res, next, error); }
});

// A payment recovered after the PDV had to leave the sale unclosed may complete it: emits the fiscal document when the company's rule requires it. A fiscal problem never undoes the payment.
async function fiscalAfterRecovery(req: import('express').Request, orderId: string): Promise<AfterPaymentResult | null> {
  try { return await emitAfterPayment({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, unitId: req.auth!.unitId ?? null }, orderId); }
  catch { return { action: 'FAILED', message: 'Falha ao emitir o documento fiscal; tente pela tela Fiscal.' }; }
}

const view = (transaction: Awaited<ReturnType<typeof loadTransaction>> & object) => ({
  id: transaction.id, orderId: transaction.orderId, provider: transaction.provider, simulated: transaction.simulated, method: transaction.method, amount: transaction.amount, installments: transaction.installments, status: transaction.status,
  nsu: transaction.nsu, authorizationCode: transaction.authorizationCode, cardBrand: transaction.cardBrand, acquirerCnpj: transaction.acquirerCnpj, pixEndToEnd: transaction.pixEndToEnd, terminalId: transaction.terminalId,
  responseCode: transaction.responseCode, responseMessage: transaction.responseMessage, paymentId: transaction.paymentId, reversalRef: transaction.reversalRef === 'IN_PROGRESS' ? null : transaction.reversalRef, reversalInProgress: transaction.reversalRef === 'IN_PROGRESS',
  reversalReason: transaction.reversalReason, reversedAt: transaction.reversedAt, requestedAt: transaction.requestedAt, completedAt: transaction.completedAt,
});

tefRoutes.get('/transactions', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && (req.query.status in TefStatus) ? req.query.status as TefStatus : undefined;
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
    const own = FINANCE_ROLES.includes(req.auth!.role) ? {} : { operatorUserId: req.auth!.userId };
    const items = await prisma.tefTransaction.findMany({ where: { tenantId: req.auth!.tenantId!, ...own, ...(unitOf(req) ? { unitId: unitOf(req)! } : {}), ...(status ? { status } : {}), ...(orderId ? { orderId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const orders = new Map((await prisma.order.findMany({ where: { id: { in: [...new Set(items.map(item => item.orderId))] }, tenantId: req.auth!.tenantId! }, select: { id: true, code: true } })).map(order => [order.id, order.code]));
    return res.json({ items: items.map(item => ({ ...view(item), orderCode: orders.get(item.orderId) ?? null })), total: items.length });
  } catch (error) { return next(error); }
});

tefRoutes.get('/transactions/:id', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const transaction = await loadTransaction(req.auth!.tenantId!, req.params.id, unitOf(req), FINANCE_ROLES.includes(req.auth!.role) ? null : req.auth!.userId);
    if (!transaction) return res.status(404).json({ message: 'Transação não encontrada.' });
    const events = await prisma.tefEvent.findMany({ where: { transactionId: transaction.id, tenantId: transaction.tenantId }, orderBy: { createdAt: 'asc' }, take: 200 });
    return res.json({ transaction: view(transaction), events });
  } catch (error) { return next(error); }
});

// Asks the provider for the real state; it never resends the charge.
tefRoutes.post('/transactions/:id/sync', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const transaction = await loadTransaction(req.auth!.tenantId!, req.params.id, unitOf(req), FINANCE_ROLES.includes(req.auth!.role) ? null : req.auth!.userId);
    if (!transaction) return res.status(404).json({ message: 'Transação não encontrada.' });
    const updated = await syncTransaction(transaction, req.auth!.userId);
    await autoPrintTefReceipt(updated, req.auth!.userId);
    const fiscal = updated.status === TefStatus.APPROVED && transaction.status !== TefStatus.APPROVED ? await fiscalAfterRecovery(req, updated.orderId) : null;
    return res.json({ transaction: view(updated), paid: updated.status === TefStatus.APPROVED, fiscal });
  } catch (error) { return handle(res, next, error); }
});

tefRoutes.post('/transactions/:id/cancel', requireRoles(...FINANCE_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().min(5).max(300), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Informe o motivo (mín. 5 caracteres) e confirme o cancelamento.' });
    const transaction = await loadTransaction(req.auth!.tenantId!, req.params.id, unitOf(req), FINANCE_ROLES.includes(req.auth!.role) ? null : req.auth!.userId);
    if (!transaction) return res.status(404).json({ message: 'Transação não encontrada.' });
    const updated = await reverseTransaction(transaction, req.auth!.userId, parsed.data.reason);
    // Cancelling the card payment does not cancel the fiscal document: it is flagged so it is handled with the proper fiscal event.
    const authorizedDocument = await prisma.fiscalDocument.findFirst({ where: { tenantId: transaction.tenantId, orderId: transaction.orderId, status: 'AUTHORIZED' }, select: { id: true, kind: true, number: true } });
    return res.json({ transaction: view(updated), fiscalWarning: authorizedDocument ? 'Há documento fiscal autorizado para este pedido: cancele ou emita o evento fiscal cabível; ele não foi alterado.' : null });
  } catch (error) { return handle(res, next, error); }
});

// Undo of a charge that is still unresolved (never of an approved one: that is a reversal). Only a provider-confirmed cancellation closes it.
tefRoutes.post('/transactions/:id/undo', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().min(5).max(300), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Informe o motivo (mín. 5 caracteres) e confirme o desfazimento.' });
    const transaction = await loadTransaction(req.auth!.tenantId!, req.params.id, unitOf(req), FINANCE_ROLES.includes(req.auth!.role) ? null : req.auth!.userId);
    if (!transaction) return res.status(404).json({ message: 'Transação não encontrada.' });
    const result = await undoTransaction(transaction, req.auth!.userId, parsed.data.reason);
    const message = result.outcome === 'APPROVED_USE_REVERSAL' ? 'O provedor informa que a transação foi APROVADA: o pagamento foi registrado e só pode ser desfeito por estorno.' : result.outcome === 'ALREADY_CLOSED' ? 'A transação já estava encerrada.' : null;
    return res.status(result.outcome === 'UNDONE' ? 200 : 409).json({ transaction: view(result.transaction), outcome: result.outcome, paid: result.transaction.status === TefStatus.APPROVED, message });
  } catch (error) { return handle(res, next, error); }
});

// Recovery sweep over unresolved transactions (queries the provider; never resends a charge). Cashiers recover only their own.
tefRoutes.post('/recover', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const own = FINANCE_ROLES.includes(req.auth!.role) ? null : req.auth!.userId;
    const summary = await recoverInFlight(req.auth!.tenantId!, unitOf(req), req.auth!.userId, 1, own);
    const fiscal: Array<AfterPaymentResult & { orderId: string }> = [];
    for (const orderId of [...new Set(summary.approvedOrderIds)]) { const outcome = await fiscalAfterRecovery(req, orderId); if (outcome) fiscal.push({ ...outcome, orderId }); }
    if (summary.checked > 0) await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'TEF_RECOVERY_SWEEP', entityType: 'TefTransaction', entityId: 'sweep', metadata: { checked: summary.checked, approved: summary.approved, denied: summary.denied, stillPending: summary.stillPending, failed: summary.failed } } });
    return res.json({ ...summary, fiscal });
  } catch (error) { return handle(res, next, error); }
});

// Event log of the TEF flow (status changes and notes). No monetary amounts: those stay on the transaction, behind the financial permission.
tefRoutes.get('/events', requireRoles(...FINANCE_ROLES), async (req, res, next) => {
  try {
    const toStatus = typeof req.query.status === 'string' && (req.query.status in TefStatus) ? req.query.status as TefStatus : undefined;
    const items = await prisma.tefEvent.findMany({ where: { tenantId: req.auth!.tenantId!, ...(toStatus ? { toStatus } : {}), ...(unitOf(req) ? { transaction: { unitId: unitOf(req)! } } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, include: { transaction: { select: { orderId: true, provider: true, method: true, simulated: true } } } });
    const orders = new Map((await prisma.order.findMany({ where: { id: { in: [...new Set(items.map(item => item.transaction.orderId))] }, tenantId: req.auth!.tenantId! }, select: { id: true, code: true } })).map(order => [order.id, order.code]));
    return res.json({ items: items.map(({ payload, transaction, ...event }) => ({ ...event, orderCode: orders.get(transaction.orderId) ?? null, provider: transaction.provider, method: transaction.method, simulated: transaction.simulated })), total: items.length });
  } catch (error) { return next(error); }
});

// ---- Monitoring and reconciliation ----
tefRoutes.get('/monitor', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try { return res.json(await monitor(req.auth!.tenantId!, unitOf(req), FINANCE_ROLES.includes(req.auth!.role))); } catch (error) { return next(error); }
});

tefRoutes.get('/reconciliation', requireRoles(...FINANCE_ROLES), async (req, res, next) => {
  try {
    const now = new Date();
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    return res.json(await reconcile(req.auth!.tenantId!, from, to, unitOf(req)));
  } catch (error) { return next(error); }
});
