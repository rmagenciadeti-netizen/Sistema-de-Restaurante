import { FiscalEnvironment, FiscalKind, FiscalStatus, OrderStatus, Prisma, type FiscalDocument, type FiscalSettings, type OperationNature, type TaxRule } from '@prisma/client';
import { prisma } from './prisma';
import { environmentOf, fiscalContextForUnit, FiscalConfigError, issuerForUnit, loadFiscalSettings, modelOf, type FiscalIssuer } from './fiscal-config';
import { cfopSettingsOf, destinationOf, natureApplies, resolveCfop } from './fiscal-cfop';
import { fiscalUnitKey, independentFiscalUnitIds, reserveFiscalNumber } from './fiscal-numbering';
import { fiscalProviders, type FiscalContext, type FiscalEmission, type FiscalItemTax, type FiscalOrder, type FiscalProvider, type FiscalRecipient } from './providers';

export type Actor = { tenantId: string; userId: string; unitId: string | null };
export type ItemOverride = Partial<Record<keyof FiscalItemTax, string | number | null>> & { index: number };
export type EmissionOptions = {
  provider?: string; kind: FiscalKind; nature?: string; finality?: '1' | '2' | '3' | '4'; freight?: number; otherExpenses?: number; additionalInfo?: string;
  recipient?: FiscalRecipient | null; items?: ItemOverride[];
};
export type ServiceResult = { status: number; body: unknown };

const decimalText = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : value.toString());
const unitScope = (actor: Actor) => (actor.unitId ? { unitId: actor.unitId } : {});
// A PENDING row older than this belongs to a crashed attempt and may be retried (after consulting the provider).
const STALE_MS = 10 * 60 * 1000;
const RETRYABLE: FiscalStatus[] = [FiscalStatus.REJECTED, FiscalStatus.PROCESSING, FiscalStatus.CONTINGENCY];

const ruleInForce = (rule: TaxRule | null | undefined, now = new Date()) => Boolean(rule?.active && (!rule.validFrom || rule.validFrom <= now) && (!rule.validTo || rule.validTo >= now));

export function taxOf(rule: TaxRule, product: { ncm: string | null; cest: string | null }): FiscalItemTax {
  const tax: FiscalItemTax = { ncm: product.ncm ?? rule.ncm, cest: product.cest ?? rule.cest, origin: rule.origin, cfop: rule.cfop, icmsCst: rule.icmsCst, icmsRate: decimalText(rule.icmsRate), icmsReduction: decimalText(rule.icmsReduction), pisCst: rule.pisCst, pisRate: decimalText(rule.pisRate), cofinsCst: rule.cofinsCst, cofinsRate: decimalText(rule.cofinsRate) };
  // Extended groups (ST, FCP, IPI, IBS/CBS) are only present when the rule defines them.
  const extra: Partial<FiscalItemTax> = {
    icmsStMva: decimalText(rule.icmsStMva), icmsStRate: decimalText(rule.icmsStRate), icmsStReduction: decimalText(rule.icmsStReduction), fcpRate: decimalText(rule.fcpRate), fcpStRate: decimalText(rule.fcpStRate), cBenef: rule.cBenef,
    ipiCst: rule.ipiCst, ipiEnquadramento: rule.ipiEnquadramento, ipiRate: decimalText(rule.ipiRate), ibsCbsCst: rule.ibsCbsCst, cClassTrib: rule.cClassTrib, ibsUfRate: decimalText(rule.ibsUfRate), ibsMunRate: decimalText(rule.ibsMunRate), cbsRate: decimalText(rule.cbsRate), isRate: decimalText(rule.isRate),
  };
  for (const [key, value] of Object.entries(extra)) if (value !== null && value !== undefined) (tax as Record<string, unknown>)[key] = value;
  return tax;
}

// Per-document edits never touch the registered defaults: they only change this document's snapshot.
function applyOverride(tax: FiscalItemTax, override: ItemOverride | undefined): FiscalItemTax {
  if (!override) return tax;
  const next: Record<string, unknown> = { ...tax };
  for (const [key, value] of Object.entries(override)) {
    if (key === 'index' || value === undefined) continue;
    next[key] = key === 'origin' ? Number(value) : value === null || value === '' ? null : String(value);
  }
  return next as FiscalItemTax;
}

async function loadOrder(actor: Actor, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, tenantId: actor.tenantId, ...unitScope(actor) },
    include: {
      items: { where: { parentItemId: null }, include: { product: { select: { name: true, code: true, gtin: true, measureUnit: true, ncm: true, cest: true, taxRule: true } } } },
      customer: { select: { name: true, document: true, email: true } }, payments: { where: { status: 'CONFIRMED' }, select: { method: true, amount: true, integrated: true, acquirerCnpj: true, cardBrand: true, authorizationCode: true, pixEndToEnd: true } },
    },
  });
}
type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

export type FiscalScope = { issuer: Pick<FiscalIssuer, 'uf' | 'taxRegime'>; nature?: (OperationNature & { taxRule: TaxRule | null }) | null };
const natureName = (settings: FiscalSettings | null, options: EmissionOptions) => (options.nature ?? (settings ? modelOf(settings, options.kind).nature : '')).trim();

// The operation nature named by the document (or by the company model) supplies CFOP/tax rule when its criteria match the operation.
export async function loadNature(tenantId: string, settings: FiscalSettings | null, options: EmissionOptions) {
  const name = natureName(settings, options);
  return name ? prisma.operationNature.findFirst({ where: { tenantId, active: true, name: { equals: name, mode: 'insensitive' } }, include: { taxRule: true } }) : null;
}
export async function fiscalScope(tenantId: string, unitId: string | null, settings: FiscalSettings | null, options: EmissionOptions): Promise<FiscalScope> {
  const [issuer, nature] = await Promise.all([issuerForUnit(prisma, settings, tenantId, unitId), loadNature(tenantId, settings, options)]);
  return { issuer, nature };
}

// Builds the provider payload from the order, the product tax rules (or the company default rule) and the document-level options.
export function buildFiscalOrder(order: LoadedOrder, settings: (FiscalSettings & { defaultTaxRule?: TaxRule | null }) | null, options: EmissionOptions, numbering: { series: string; number: string }, ref?: string, scope?: FiscalScope): { fiscalOrder: FiscalOrder } | { untaxed: string[] } {
  const recipientUf = options.recipient?.address?.uf ?? null;
  const destination = scope ? destinationOf(options.kind, scope.issuer.uf, recipientUf) : 'INTERNAL';
  const nature = scope && natureApplies(scope.nature, { destination, issuerUf: scope.issuer.uf, recipientUf, taxRegime: scope.issuer.taxRegime }) ? scope.nature! : null;
  const natureRule = ruleInForce(nature?.taxRule) ? nature!.taxRule! : null;
  const fallback = ruleInForce(settings?.defaultTaxRule) ? settings!.defaultTaxRule! : natureRule;
  const ruleFor = (item: LoadedOrder['items'][number]) => (ruleInForce(item.product.taxRule) ? item.product.taxRule! : fallback);
  const untaxed = [...new Set(order.items.filter(item => !ruleFor(item)).map(item => item.product.name))];
  if (untaxed.length > 0) return { untaxed };
  const model = modelOf(settings, options.kind);
  const overrides = new Map((options.items ?? []).map(item => [item.index, item]));
  const recipient = options.recipient ?? { name: order.customer?.name ?? order.customerName, document: order.customer?.document ?? null, email: order.customer?.email ?? null };
  const fiscalOrder: FiscalOrder = {
    orderId: order.id, code: order.code, total: order.total.toFixed(2), issuedAt: new Date(), series: numbering.series, number: numbering.number, customer: recipient,
    items: order.items.map((item, index) => {
      const rule = ruleFor(item)!;
      const tax = taxOf(rule, item.product);
      const cfop = resolveCfop({ ruleCfop: rule.cfop, ruleCfopInterstate: rule.cfopInterstate, natureCfop: nature?.cfop, settings: cfopSettingsOf(settings?.cfop), modelDefault: model.defaultCfop, destination, returning: options.finality === '4' });
      if (cfop) tax.cfop = cfop;
      return { name: item.product.name, quantity: Number(item.quantity), unitPrice: item.unitPrice.toFixed(2), total: item.total.toFixed(2), tax: applyOverride(tax, overrides.get(index)), code: item.product.code ?? undefined, gtin: item.product.gtin, unit: item.product.measureUnit };
    }),
  };
  // Optional document data is only attached when configured, so providers keep receiving the minimal payload otherwise.
  const extras: Partial<FiscalOrder> = {
    ref, nature: options.nature ?? (settings ? model.nature : undefined), finality: options.finality ?? (settings ? model.finality : undefined),
    freight: options.freight ? options.freight.toFixed(2) : undefined, otherExpenses: options.otherExpenses ? options.otherExpenses.toFixed(2) : undefined,
    discount: Number(order.discount) > 0 ? order.discount.toFixed(2) : undefined, additionalInfo: options.additionalInfo || (settings ? model.additionalInfo || undefined : undefined),
    payments: order.payments.length ? order.payments.map(payment => ({ method: payment.method, amount: payment.amount.toFixed(2), integrated: payment.integrated, acquirerCnpj: payment.acquirerCnpj, cardBrand: payment.cardBrand, authorizationCode: payment.authorizationCode, pixEndToEnd: payment.pixEndToEnd })) : undefined,
    destination: destination === 'INTERSTATE' ? '2' : undefined,
  };
  for (const [key, value] of Object.entries(extras)) if (value !== undefined) (fiscalOrder as Record<string, unknown>)[key] = value;
  return { fiscalOrder };
}

export type AfterPaymentResult = { action: 'NONE' | 'EMITTED' | 'ASK_OPERATOR' | 'NOT_FULLY_PAID' | 'FAILED'; message?: string; status?: number };

// A payment confirmed later (TEF recovery/consultation) completes a sale that the PDV could not close. When the company's rule is FISCAL (or the sale was already decided FISCAL) the document is emitted now,
// only if the order is fully paid with the REAL confirmed payments. ASK stays a human decision. The (order, kind) uniqueness of emitForOrder prevents a second document.
export async function emitAfterPayment(actor: Actor, orderId: string): Promise<AfterPaymentResult> {
  const settings = await loadFiscalSettings(prisma, actor.tenantId);
  const mode = settings?.pdvMode ?? 'NON_FISCAL';
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: actor.tenantId, ...unitScope(actor) }, select: { id: true, total: true, status: true, fiscalMode: true, payments: { where: { status: 'CONFIRMED' }, select: { amount: true } } } });
  if (!order || order.status === OrderStatus.CANCELLED || order.fiscalMode === 'NON_FISCAL') return { action: 'NONE' };
  if (order.fiscalMode !== 'FISCAL') {
    if (mode === 'NON_FISCAL') return { action: 'NONE' };
    if (mode === 'ASK') return { action: 'ASK_OPERATOR', message: 'Pagamento confirmado após o fechamento: decida na tela do pedido se deseja emitir o documento fiscal.' };
  }
  const paid = order.payments.reduce((sum, payment) => sum.add(payment.amount), new Prisma.Decimal(0));
  if (paid.lt(order.total)) return { action: 'NOT_FULLY_PAID', message: 'O pedido ainda não está totalmente pago; o documento será emitido quando o pagamento fechar o total.' };
  if (order.fiscalMode !== 'FISCAL') {
    const decided = await prisma.order.updateMany({ where: { id: order.id, fiscalMode: null }, data: { fiscalMode: 'FISCAL', fiscalDecidedById: actor.userId, fiscalDecidedAt: new Date() } });
    if (decided.count !== 1) return { action: 'NONE' };
    await prisma.auditLog.create({ data: { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'PDV_FISCAL_DECISION', entityType: 'Order', entityId: order.id, metadata: { mode, emit: true, trigger: 'PAYMENT_CONFIRMED_AFTER_CHECKOUT' } } });
  }
  const result = await emitForOrder(actor, order.id, { kind: FiscalKind.NFCE });
  const body = result.body as { message?: string };
  // 409 means a document already exists (or is being emitted): nothing to do and nothing duplicated.
  if (result.status === 201 || result.status === 202) return { action: 'EMITTED', status: result.status };
  return result.status === 409 ? { action: 'NONE', status: 409 } : { action: 'FAILED', status: result.status, message: body.message };
}

// Pre-flight check before a number is reserved: the document must total what the order totals and what was really paid. Nothing is completed or invented to make it fit.
export function fiscalPaymentIssue(order: Pick<LoadedOrder, 'total' | 'discount' | 'items' | 'payments'>, options: Pick<EmissionOptions, 'kind' | 'finality' | 'freight' | 'otherExpenses'>): string | null {
  if (['3', '4'].includes(options.finality ?? '1')) return null;
  const cents = (value: { toString(): string } | number | undefined | null) => Math.round(Number(value ?? 0) * 100);
  const baseTotal = order.items.reduce((sum, item) => sum + cents(item.total), 0) - cents(order.discount);
  const extras = cents(options.freight) + cents(options.otherExpenses);
  const documentTotal = baseTotal + extras;
  const brl = (value: number) => (value / 100).toFixed(2).replace('.', ',');
  // Fees the order charged (service, couvert, delivery) must be carried by the document as freight/other expenses, otherwise payment and document totals cannot match.
  if (cents(order.total) - baseTotal > extras + 1) return `O total do pedido (R$ ${brl(cents(order.total))}) inclui R$ ${brl(cents(order.total) - baseTotal - extras)} (taxa de serviço, couvert ou entrega) que o documento fiscal não carrega: informe-os como outras despesas/frete.`;
  const paid = order.payments.reduce((sum, payment) => sum + cents(payment.amount), 0);
  if (options.kind === FiscalKind.NFE && paid === 0) return null;
  if (paid < documentTotal) return `Pagamento confirmado (R$ ${brl(paid)}) menor que o total (R$ ${brl(documentTotal)}): registre ou recupere o pagamento antes de emitir.`;
  const cash = order.payments.filter(payment => payment.method === 'CASH').reduce((sum, payment) => sum + cents(payment.amount), 0);
  if (paid - documentTotal > cash) return 'O valor pago excede o total e a diferença não pode ser troco em dinheiro: revise os pagamentos.';
  return null;
}

async function settingsWithRule(tenantId: string) {
  return prisma.fiscalSettings.findUnique({ where: { tenantId }, include: { defaultTaxRule: true } });
}
async function contingencyActive(tenantId: string) {
  return Boolean(await prisma.fiscalContingency.findFirst({ where: { tenantId, endedAt: null }, select: { id: true } }));
}

export async function recordEvent(data: Prisma.FiscalEventUncheckedCreateInput) {
  return prisma.fiscalEvent.create({ data });
}

const STATUS_OF: Record<FiscalEmission['status'], FiscalStatus | null> = { AUTHORIZED: FiscalStatus.AUTHORIZED, REJECTED: FiscalStatus.REJECTED, PROCESSING: FiscalStatus.PROCESSING, DENIED: FiscalStatus.DENIED, CANCELLED: FiscalStatus.CANCELLED, NOT_FOUND: null };

async function applyResult(document: FiscalDocument, result: FiscalEmission, actor: Actor, type: 'EMISSION' | 'CONSULT', fallbackStatus: FiscalStatus) {
  const status = STATUS_OF[result.status] ?? fallbackStatus;
  const saved = await prisma.fiscalDocument.update({
    where: { id: document.id },
    data: {
      status, number: result.number ?? document.number, accessKey: result.accessKey ?? document.accessKey, documentUrl: result.documentUrl ?? document.documentUrl,
      protocol: result.protocol ?? document.protocol, statusCode: result.statusCode ?? document.statusCode, xml: result.xml ?? document.xml,
      error: status === FiscalStatus.AUTHORIZED ? null : (result.error ?? (status === FiscalStatus.PROCESSING ? 'Aguardando retorno da SEFAZ' : document.error)),
      ...(result.contingency ? { contingency: true, contingencyAt: document.contingencyAt ?? new Date() } : {}),
      ...(type === 'EMISSION' ? { attempts: { increment: 1 }, lastAttemptAt: new Date() } : {}),
    },
  });
  await recordEvent({ tenantId: actor.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type, status: result.status, kind: document.kind, protocol: result.protocol, message: result.error ?? null, xml: result.xml, actorUserId: actor.userId });
  return saved;
}

// Sends (or re-sends) one document. A document that was already sent is consulted first: a missing protocol never means "not authorized".
export async function transmit(document: FiscalDocument, provider: FiscalProvider, fiscalOrder: FiscalOrder, actor: Actor, context: FiscalContext, previous: FiscalStatus): Promise<FiscalDocument> {
  if (provider.consult && (document.attempts > 0 || previous === FiscalStatus.PROCESSING)) {
    try {
      const found = await provider.consult({ ref: document.id, kind: document.kind, number: document.number, series: document.series, accessKey: document.accessKey }, context);
      if (found.status !== 'NOT_FOUND' && found.status !== 'REJECTED') return applyResult(document, found, actor, 'CONSULT', FiscalStatus.PROCESSING);
    } catch {
      return markCommunicationFailure(document, actor, context, 'Falha ao consultar a SEFAZ antes do reenvio; tente novamente.');
    }
  }
  try {
    const result = await provider.emit(fiscalOrder, document.kind, context);
    return applyResult(document, result, actor, 'EMISSION', FiscalStatus.PROCESSING);
  } catch (error) {
    if (error instanceof FiscalConfigError) {
      const saved = await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: FiscalStatus.REJECTED, error: error.message } });
      await recordEvent({ tenantId: actor.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: 'EMISSION', status: 'REJECTED', kind: document.kind, message: error.message, actorUserId: actor.userId });
      return saved;
    }
    return markCommunicationFailure(document, actor, context, 'PROVIDER_ERROR');
  }
}

// The request may have reached SEFAZ: the document stays "sem protocolo" (or in NFC-e contingency) and must be consulted before any retry.
async function markCommunicationFailure(document: FiscalDocument, actor: Actor, context: FiscalContext, message: string) {
  const contingency = context.contingency && document.kind === FiscalKind.NFCE;
  const saved = await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: contingency ? FiscalStatus.CONTINGENCY : FiscalStatus.PROCESSING, error: message, attempts: { increment: 1 }, lastAttemptAt: new Date(), ...(contingency ? { contingency: true, contingencyAt: document.contingencyAt ?? new Date() } : {}) } });
  await recordEvent({ tenantId: actor.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: contingency ? 'CONTINGENCY' : 'EMISSION', status: 'COMMUNICATION_FAILURE', kind: document.kind, message, actorUserId: actor.userId });
  return saved;
}

export const emissionHttpStatus = (status: FiscalStatus) => (status === FiscalStatus.AUTHORIZED ? 201 : status === FiscalStatus.REJECTED || status === FiscalStatus.DENIED ? 422 : status === FiscalStatus.PROCESSING || status === FiscalStatus.CONTINGENCY ? 202 : 200);

export async function emitForOrder(actor: Actor, orderId: string, options: EmissionOptions): Promise<ServiceResult> {
  const settings = await settingsWithRule(actor.tenantId);
  const providerName = options.provider ?? settings?.provider ?? undefined;
  const provider = providerName ? fiscalProviders.get(providerName) : undefined;
  if (!provider) return { status: 501, body: { message: 'Fiscal provider is not configured' } };
  const order = await loadOrder(actor, orderId);
  if (!order) return { status: 404, body: { message: 'Order not found' } };
  if (order.status === OrderStatus.CANCELLED) return { status: 409, body: { message: 'Cancelled orders cannot be invoiced' } };
  const scope = await fiscalScope(actor.tenantId, order.unitId, settings, options);
  const probe = buildFiscalOrder(order, settings, options, { series: '', number: '' }, undefined, scope);
  if ('untaxed' in probe) return { status: 422, body: { message: `Vincule uma regra tributária ativa (Fiscal / Tributos) aos produtos: ${probe.untaxed.join(', ')}.` } };
  const paymentIssue = fiscalPaymentIssue(order, options);
  if (paymentIssue) return { status: 422, body: { message: paymentIssue, code: 'FISCAL_PAYMENT_MISMATCH' } };
  const environment = environmentOf(settings);
  const unitKey = await fiscalUnitKey(prisma, actor.tenantId, order.unitId);
  let context: FiscalContext;
  try { context = await fiscalContextForUnit(prisma, settings, actor.tenantId, order.unitId, { contingency: await contingencyActive(actor.tenantId) }); } catch (error) { if (error instanceof FiscalConfigError) return { status: error.status, body: { message: error.message } }; throw error; }

  const existing = await prisma.fiscalDocument.findUnique({ where: { orderId_kind: { orderId: order.id, kind: options.kind } } });
  if (existing && existing.environment !== environment) return { status: 409, body: { message: `Este pedido já possui ${options.kind === 'NFE' ? 'NF-e' : 'NFC-e'} em ${existing.environment === 'PRODUCTION' ? 'produção' : 'homologação'}; não é possível emitir outra no ambiente atual.` } };
  const stale = new Date(Date.now() - STALE_MS);
  const retryable = (doc: FiscalDocument) => RETRYABLE.includes(doc.status) || (doc.status === FiscalStatus.PENDING && doc.updatedAt < stale);
  if (existing && !retryable(existing)) return { status: 409, body: { message: existing.status === FiscalStatus.PENDING ? 'Emission already in progress' : 'A fiscal document already exists for this order' } };
  // The unique (orderId, kind) row doubles as an emission lock; the optimistic updatedAt check blocks concurrent retries.
  // A retry keeps the number already reserved for this order; a new document takes the next one of the tenant's series.
  const document = existing
    ? (await prisma.fiscalDocument.updateMany({ where: { id: existing.id, updatedAt: existing.updatedAt }, data: { status: FiscalStatus.PENDING, provider: provider.name, error: null, issuedById: actor.userId } })).count === 1 ? existing : null
    : await prisma.$transaction(async tx => {
      const { series, number } = await reserveFiscalNumber(tx, actor.tenantId, options.kind, environment, unitKey);
      return tx.fiscalDocument.create({ data: { tenantId: actor.tenantId, unitId: order.unitId, orderId: order.id, provider: provider.name, kind: options.kind, series, number, environment, issuedById: actor.userId } });
    }).catch(() => null);
  if (!document) return { status: 409, body: { message: 'Emission already in progress' } };
  // Documents created before numbering existed have no reserved number yet.
  const reserved = document.number && document.series ? { series: document.series, number: document.number } : await prisma.$transaction(async tx => {
    const next = await reserveFiscalNumber(tx, actor.tenantId, options.kind, environment, unitKey);
    await tx.fiscalDocument.update({ where: { id: document.id }, data: next });
    return next;
  });
  const built = buildFiscalOrder(order, settings, options, reserved, document.id, scope) as { fiscalOrder: FiscalOrder };
  await prisma.fiscalDocument.update({ where: { id: document.id }, data: { payload: JSON.parse(JSON.stringify(built.fiscalOrder)) as Prisma.InputJsonValue } });
  const saved = await transmit({ ...document, ...reserved }, provider, built.fiscalOrder, actor, context, existing?.status ?? FiscalStatus.PENDING);
  await prisma.auditLog.create({ data: { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'FISCAL_EMITTED', entityType: 'FiscalDocument', entityId: saved.id, metadata: { status: saved.status, environment } } });
  if (saved.error === 'PROVIDER_ERROR') return { status: 502, body: { ...saved, message: 'Falha de comunicação com o provedor fiscal: o documento ficou sem protocolo e será consultado antes de qualquer reenvio.' } };
  return { status: emissionHttpStatus(saved.status), body: saved };
}

// Re-sends a pending/contingency/rejected document using the snapshot stored at emission (the number never changes).
export async function retransmit(actor: Actor, document: FiscalDocument): Promise<FiscalDocument | { failure: string }> {
  const provider = fiscalProviders.get(document.provider);
  if (!provider) return { failure: 'Provedor fiscal não configurado.' };
  const stale = new Date(Date.now() - STALE_MS);
  if (!RETRYABLE.includes(document.status) && !(document.status === FiscalStatus.PENDING && document.updatedAt < stale)) return { failure: 'Documento não está pendente de transmissão.' };
  if (!document.payload) return { failure: 'Documento sem dados de emissão; reenvie pelo pedido.' };
  const settings = await loadFiscalSettings(prisma, actor.tenantId);
  if (environmentOf(settings) !== document.environment) return { failure: 'O ambiente fiscal atual é diferente do ambiente do documento.' };
  const locked = await prisma.fiscalDocument.updateMany({ where: { id: document.id, updatedAt: document.updatedAt }, data: { status: FiscalStatus.PENDING } });
  if (locked.count !== 1) return { failure: 'Documento em processamento por outra operação.' };
  const payload = document.payload as unknown as FiscalOrder;
  return transmit(document, provider, { ...payload, issuedAt: new Date(payload.issuedAt) }, actor, await fiscalContextForUnit(prisma, settings, actor.tenantId, document.unitId, { contingency: await contingencyActive(actor.tenantId) }), document.status);
}

// Asks the provider/SEFAZ for the real state of a document (lost return, async batch, contingency).
export async function consultDocument(actor: Actor, document: FiscalDocument): Promise<FiscalDocument | { failure: string }> {
  const provider = fiscalProviders.get(document.provider);
  if (!provider?.consult) return { failure: 'O provedor fiscal configurado não oferece consulta de situação.' };
  const settings = await loadFiscalSettings(prisma, actor.tenantId);
  if (environmentOf(settings) !== document.environment) return { failure: 'O ambiente fiscal atual é diferente do ambiente do documento.' };
  try {
    const found = await provider.consult({ ref: document.id, kind: document.kind, number: document.number, series: document.series, accessKey: document.accessKey }, await fiscalContextForUnit(prisma, settings, actor.tenantId, document.unitId));
    if (found.status === 'NOT_FOUND') {
      await recordEvent({ tenantId: actor.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: 'CONSULT', status: 'NOT_FOUND', kind: document.kind, message: found.error ?? 'Documento não localizado', actorUserId: actor.userId });
      return prisma.fiscalDocument.update({ where: { id: document.id }, data: { error: 'Documento não localizado na SEFAZ/provedor; pode ser reenviado.' } });
    }
    return applyResult(document, found, actor, 'CONSULT', document.status);
  } catch (error) {
    if (error instanceof FiscalConfigError) return { failure: error.message };
    await recordEvent({ tenantId: actor.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: 'CONSULT', status: 'COMMUNICATION_FAILURE', kind: document.kind, message: 'Falha de comunicação na consulta', actorUserId: actor.userId });
    return { failure: 'Falha de comunicação ao consultar a SEFAZ; tente novamente.' };
  }
}

export type InutilizationRequest = { kind: FiscalKind; series: string; numberFrom: number; numberTo: number; justification: string };
// Validates a range before asking SEFAZ: never inutilizes a number that belongs to any document (authorized, pending, rejected or cancelled).
export async function inutilize(actor: Actor, request: InutilizationRequest): Promise<ServiceResult> {
  const settings = await loadFiscalSettings(prisma, actor.tenantId);
  const environment = environmentOf(settings);
  const unitKey = await fiscalUnitKey(prisma, actor.tenantId, actor.unitId);
  const provider = settings?.provider ? fiscalProviders.get(settings.provider) : fiscalProviders.get(fiscalProviders.names()[0] ?? '');
  if (!provider?.inutilize) return { status: 501, body: { message: 'O provedor fiscal configurado não oferece inutilização de numeração.' } };
  const { kind, series, numberFrom, numberTo, justification } = request;
  // Company-scope inutilization ignores establishments with their own CNPJ: their numbers live in a separate space.
  const independents = unitKey ? [] : await independentFiscalUnitIds(prisma, actor.tenantId);
  const unitFilter = unitKey ? Prisma.sql`AND "unitId" = ${unitKey}` : independents.length ? Prisma.sql`AND ("unitId" IS NULL OR "unitId" NOT IN (${Prisma.join(independents)}))` : Prisma.empty;
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM "FiscalDocument" WHERE "tenantId" = ${actor.tenantId} AND "kind" = ${kind}::"FiscalKind" AND "environment" = ${environment}::"FiscalEnvironment" AND "series" = ${series} ${unitFilter} AND "number" ~ '^[0-9]{1,9}$' AND "number"::int BETWEEN ${numberFrom} AND ${numberTo}`;
  if (Number(count) > 0) return { status: 409, body: { message: `Há ${count} documento(s) com números nessa faixa (autorizados, pendentes, rejeitados ou cancelados). Consulte-os antes; números utilizados não podem ser inutilizados.` } };
  const eventScope = unitKey ? { unitId: unitKey } : independents.length ? { OR: [{ unitId: null }, { unitId: { notIn: independents } }] } : {};
  const overlap = await prisma.fiscalEvent.findFirst({ where: { tenantId: actor.tenantId, ...eventScope, type: 'INUTILIZATION', status: 'REGISTERED', environment, kind, series, numberFrom: { lte: numberTo }, numberTo: { gte: numberFrom } } });
  if (overlap) return { status: 409, body: { message: `A faixa ${overlap.numberFrom}–${overlap.numberTo} já foi inutilizada (protocolo ${overlap.protocol ?? '—'}).` } };
  // Numbers at or beyond the next sequential number are moved past the range first, so no emission can take them meanwhile.
  await prisma.$transaction(async tx => {
    await tx.fiscalNumbering.createMany({ data: [{ tenantId: actor.tenantId, kind, environment, unitKey }], skipDuplicates: true });
    await tx.fiscalNumbering.updateMany({ where: { tenantId: actor.tenantId, kind, environment, unitKey, series, nextNumber: { gte: numberFrom, lte: numberTo } }, data: { nextNumber: numberTo + 1 } });
  });
  let context: FiscalContext;
  try { context = await fiscalContextForUnit(prisma, settings, actor.tenantId, actor.unitId); } catch (error) { if (error instanceof FiscalConfigError) return { status: error.status, body: { message: error.message } }; throw error; }
  const result = await provider.inutilize({ kind, series, numberFrom, numberTo, year: new Date().getFullYear(), justification }, context).catch(error => ({ status: 'REJECTED' as const, error: error instanceof FiscalConfigError ? error.message : 'Falha de comunicação com o provedor fiscal.', protocol: undefined, xml: undefined }));
  const event = await recordEvent({ tenantId: actor.tenantId, unitId: actor.unitId, environment, type: 'INUTILIZATION', status: result.status, kind, series, numberFrom, numberTo, justification, protocol: result.protocol, message: result.error ?? null, xml: result.xml, actorUserId: actor.userId });
  await prisma.auditLog.create({ data: { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'FISCAL_INUTILIZATION', entityType: 'FiscalEvent', entityId: event.id, metadata: { kind, series, numberFrom, numberTo, status: result.status } } });
  return { status: result.status === 'REGISTERED' ? 201 : 422, body: { ...event, xml: undefined, hasXml: Boolean(event.xml) } };
}

export { FiscalEnvironment };
