import { CashSessionStatus, OrderStatus, PaymentMethod, PaymentStatus, Prisma, TefIntegrationStatus, TefStatus, type TefProviderConfig, type TefTransaction } from '@prisma/client';
import { prisma } from '../prisma';
import { serializable } from '../serializable';
import { syncPromissory } from '../payment-ledger';
import { openSecret } from '../fiscal-config';
import { centerLines } from '../ticket';
import { tefAdapters, TefTimeoutError, type TefAdapter, type TefConfigView, type TefResponse } from './adapter';

export class TefError extends Error { constructor(message: string, readonly status = 409, readonly code = 'TEF_ERROR') { super(message); } }

const IN_FLIGHT: TefStatus[] = [TefStatus.PENDING, TefStatus.TIMEOUT, TefStatus.UNKNOWN];
const FINAL: TefStatus[] = [TefStatus.DENIED, TefStatus.CANCELLED, TefStatus.ERROR, TefStatus.REVERSED];
const CARD: PaymentMethod[] = [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD, PaymentMethod.VOUCHER];
const USABLE: TefIntegrationStatus[] = [TefIntegrationStatus.IN_TESTING, TefIntegrationStatus.HOMOLOGATED, TefIntegrationStatus.PRODUCTION_ENABLED];
export const TEF_TIMEOUT_MS = () => Number(process.env.TEF_TIMEOUT_MS) > 0 ? Number(process.env.TEF_TIMEOUT_MS) : 90_000;

// Technical payloads are kept for audit but never carry credentials or card data.
const SENSITIVE = /token|secret|password|senha|pin|key|pan|cvv|track|credential|card.?number/i;
export function redact(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SENSITIVE.test(key) ? '[REDACTED]' : redact(inner)]));
  return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : value === null || value === undefined ? null : String(value)) as Prisma.InputJsonValue;
}

export function configView(config: TefProviderConfig): TefConfigView {
  let credentials: Record<string, string> = {};
  if (config.credentialsEnc) { try { credentials = JSON.parse(openSecret(config.credentialsEnc).toString('utf8')); } catch { throw new TefError('Credenciais do TEF ilegíveis; cadastre-as novamente.', 500, 'TEF_CREDENTIALS'); } }
  return {
    environment: config.environment === 'PRODUCTION' ? 'PRODUCTION' : 'HOMOLOGATION', establishmentCnpj: config.establishmentCnpj, merchantCode: config.merchantCode, logicalNumber: config.logicalNumber, terminalId: config.terminalId,
    cashRegisterId: config.cashRegisterId, pinpad: config.pinpad, connection: (config.connection && typeof config.connection === 'object' && !Array.isArray(config.connection) ? config.connection : {}) as Record<string, unknown>, credentials,
  };
}

async function event(tx: Prisma.TransactionClient, transaction: Pick<TefTransaction, 'id' | 'tenantId'>, from: TefStatus | null, to: TefStatus, note: string, actorUserId?: string | null, payload?: unknown) {
  await tx.tefEvent.create({ data: { tenantId: transaction.tenantId, transactionId: transaction.id, fromStatus: from, toStatus: to, note, actorUserId: actorUserId ?? null, payload: payload === undefined ? undefined : redact(payload) } });
}

export type StartInput = {
  tenantId: string; unitId: string | null; userId: string; orderId: string; provider: string; method: PaymentMethod; amount: Prisma.Decimal; installments: number; idempotencyKey: string; cashSessionId?: string; hints?: Record<string, string>;
};

// Starts (or returns, for a repeated idempotency key) a TEF payment. The provider is called outside any database transaction and a timeout is never retried blindly.
export async function startTransaction(input: StartInput): Promise<{ transaction: TefTransaction; replayed: boolean }> {
  const adapter = tefAdapters.get(input.provider);
  if (!adapter) throw new TefError('Provedor TEF não disponível neste servidor.', 501, 'TEF_PROVIDER_UNAVAILABLE');
  const config = await prisma.tefProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } } });
  if (!config || !USABLE.includes(config.integrationStatus)) throw new TefError('Provedor TEF não está configurado para uso (status mínimo: em testes).', 409, 'TEF_NOT_CONFIGURED');
  if (config.environment === 'PRODUCTION' && config.integrationStatus !== TefIntegrationStatus.PRODUCTION_ENABLED) throw new TefError('Produção só é permitida após a habilitação de produção do provedor.', 409, 'TEF_NOT_ENABLED');
  if (!adapter.capabilities.methods.includes(input.method) || (config.enabledMethods.length > 0 && !config.enabledMethods.includes(input.method))) throw new TefError('Forma de pagamento não habilitada para este provedor.', 400, 'TEF_METHOD');
  if (input.installments > 1 && !(input.method === PaymentMethod.CREDIT_CARD && adapter.capabilities.installments)) throw new TefError('Parcelamento só é permitido no crédito parcelado habilitado pelo provedor.', 400, 'TEF_INSTALLMENTS');

  const created = await serializable(prisma, async tx => {
    const existing = await tx.tefTransaction.findUnique({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.orderId !== input.orderId || !existing.amount.equals(input.amount) || existing.provider !== input.provider || existing.method !== input.method) throw new TefError('Esta chave de idempotência já foi usada em outra cobrança.', 409, 'TEF_IDEMPOTENCY_CONFLICT');
      return { transaction: existing, replayed: true };
    }
    const order = await tx.order.findFirst({ where: { id: input.orderId, tenantId: input.tenantId, ...(input.unitId ? { unitId: input.unitId } : {}) } });
    if (!order) throw new TefError('Pedido não encontrado.', 404, 'ORDER_NOT_FOUND');
    if (order.status === OrderStatus.CANCELLED) throw new TefError('Não é possível cobrar um pedido cancelado.', 409, 'ORDER_CANCELLED');
    const [paid, inFlight] = await Promise.all([
      tx.payment.aggregate({ where: { tenantId: input.tenantId, orderId: order.id, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } }),
      tx.tefTransaction.aggregate({ where: { tenantId: input.tenantId, orderId: order.id, status: { in: IN_FLIGHT } }, _sum: { amount: true } }),
    ]);
    const remaining = order.total.sub(paid._sum.amount ?? 0).sub(inFlight._sum.amount ?? 0);
    if (input.amount.gt(remaining)) throw new TefError(`O valor excede o saldo a pagar do pedido (${remaining.toFixed(2)}), considerando transações TEF em andamento.`, 409, 'TEF_EXCEEDS_BALANCE');
    const session = input.cashSessionId
      ? await tx.cashSession.findFirst({ where: { id: input.cashSessionId, tenantId: input.tenantId, unitId: order.unitId, status: CashSessionStatus.OPEN } })
      : await tx.cashSession.findFirst({ where: { tenantId: input.tenantId, unitId: order.unitId, status: CashSessionStatus.OPEN }, orderBy: { openedAt: 'desc' } });
    if (input.cashSessionId && !session) throw new TefError('Caixa inválido ou fechado.', 400, 'CASH_SESSION');
    const transaction = await tx.tefTransaction.create({ data: {
      tenantId: input.tenantId, unitId: order.unitId, orderId: order.id, cashSessionId: session?.id ?? null, provider: input.provider, simulated: adapter.simulated, method: input.method, amount: input.amount, installments: input.installments,
      idempotencyKey: input.idempotencyKey, operatorUserId: input.userId, terminalId: config.terminalId,
    } });
    await event(tx, transaction, null, TefStatus.PENDING, 'Transação criada', input.userId, { orderCode: order.code, method: input.method, amount: input.amount.toFixed(2), installments: input.installments });
    return { transaction, replayed: false, orderCode: order.code };
  });
  if (created.replayed) return { transaction: created.transaction, replayed: true };

  let response: TefResponse;
  try {
    response = await withTimeout(adapter.start({ reference: created.transaction.id, method: input.method, amount: input.amount.toFixed(2), installments: input.installments, description: `Pedido ${created.orderCode}`, hints: adapter.simulated ? input.hints : undefined }, configView(config)));
  } catch (error) {
    // The charge may have reached the provider: the state is unknown until it is queried. Never resend automatically.
    const timeout = error instanceof TefTimeoutError;
    response = { outcome: timeout ? 'TIMEOUT' : 'UNKNOWN', message: timeout ? 'Sem resposta do provedor' : 'Comunicação interrompida' };
  }
  const transaction = await applyResponse(created.transaction.id, response, input.userId);
  return { transaction, replayed: false };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TefTimeoutError('timeout')), TEF_TIMEOUT_MS());
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// Moves a transaction to the state reported by the provider. Idempotent: repeating the same answer changes nothing and never duplicates the payment.
export async function applyResponse(transactionId: string, response: TefResponse, actorUserId?: string | null): Promise<TefTransaction> {
  try {
    return await serializable(prisma, async tx => {
      const current = await tx.tefTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      const note = (text: string) => response.message ? `${text}: ${response.message}` : text;
      const move = async (to: TefStatus, text: string, data: Prisma.TefTransactionUpdateInput = {}) => {
        if (current.status === to && Object.keys(data).length === 0) return current;
        const updated = await tx.tefTransaction.update({ where: { id: current.id }, data: { status: to, responseCode: response.responseCode ?? current.responseCode, responseMessage: response.message ?? current.responseMessage, ...(FINAL.includes(to) || to === TefStatus.APPROVED ? { completedAt: new Date() } : {}), ...data } });
        await event(tx, current, current.status, to, note(text), actorUserId, { outcome: response.outcome, providerRef: response.providerRef, responseCode: response.responseCode, nsu: response.nsu, authorizationCode: response.authorizationCode });
        return updated;
      };
      if (current.status === TefStatus.APPROVED || FINAL.includes(current.status)) {
        // Late reversal discovered by a query: finalise the books; anything else on a closed transaction is ignored.
        if (current.status === TefStatus.APPROVED && response.outcome === 'REVERSED') return finaliseReversal(tx, current, response.providerRef ?? current.reversalRef ?? null, current.reversalReason ?? 'Estorno confirmado pelo provedor', actorUserId ?? null);
        return current;
      }
      switch (response.outcome) {
        case 'APPROVED': {
          const problem = validateApproval(current, response);
          if (problem) return move(TefStatus.UNKNOWN, `Aprovação rejeitada pela validação (${problem}); revisar com o provedor`, { providerRef: response.providerRef ?? current.providerRef });
          const order = await tx.order.findUnique({ where: { id: current.orderId }, select: { total: true, status: true, code: true } });
          const paid = await tx.payment.aggregate({ where: { tenantId: current.tenantId, orderId: current.orderId, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } });
          const exceeds = !order || (paid._sum.amount ?? new Prisma.Decimal(0)).add(current.amount).gt(order.total) || order.status === OrderStatus.CANCELLED;
          // Simulated approvals reach the books for testing but never carry provider data that could feed a fiscal document.
          const real = !current.simulated;
          const payment = await tx.payment.create({ data: {
            tenantId: current.tenantId, unitId: current.unitId, orderId: current.orderId, cashSessionId: current.cashSessionId, method: current.method, amount: current.amount, reference: `tef:${current.provider}:${response.providerRef}`,
            integrated: real, nsu: real ? response.nsu ?? null : null, authorizationCode: real ? response.authorizationCode ?? null : null, cardBrand: real ? response.cardBrand ?? null : null, acquirerCnpj: real ? (response.acquirerCnpj ?? '').replace(/\D/g, '') || null : null,
            installments: current.installments, pixEndToEnd: real ? response.pixEndToEnd ?? null : null, terminalId: response.terminalId ?? current.terminalId,
          } });
          await syncPromissory(tx, current.tenantId, current.orderId, 'payment');
          await tx.auditLog.create({ data: { tenantId: current.tenantId, actorUserId: actorUserId ?? null, action: 'TEF_PAYMENT_APPROVED', entityType: 'TefTransaction', entityId: current.id, metadata: { paymentId: payment.id, provider: current.provider, simulated: current.simulated, exceedsOrderBalance: exceeds } } });
          return move(TefStatus.APPROVED, 'Aprovada e validada', { providerRef: response.providerRef, nsu: response.nsu ?? null, authorizationCode: response.authorizationCode ?? null, cardBrand: response.cardBrand ?? null, acquirerCnpj: (response.acquirerCnpj ?? '').replace(/\D/g, '') || null, pixEndToEnd: response.pixEndToEnd ?? null, payment: { connect: { id: payment.id } } });
        }
        case 'DENIED': return move(TefStatus.DENIED, 'Negada');
        case 'CANCELLED': return move(TefStatus.CANCELLED, 'Cancelada antes da aprovação');
        case 'NOT_FOUND': return move(TefStatus.ERROR, 'O provedor não tem registro desta transação; nenhuma cobrança foi feita e uma nova tentativa exige nova chave');
        case 'TIMEOUT': return move(TefStatus.TIMEOUT, 'Sem resposta; consulte antes de tentar novamente', { providerRef: response.providerRef ?? current.providerRef });
        case 'UNKNOWN': return move(TefStatus.UNKNOWN, 'Resposta desconhecida; consulte antes de tentar novamente', { providerRef: response.providerRef ?? current.providerRef });
        case 'REVERSED': return move(TefStatus.UNKNOWN, 'Provedor informa estorno sem aprovação registrada; revisar');
        default: return current.status === TefStatus.PENDING ? current : move(TefStatus.PENDING, 'Aguardando o cliente/provedor');
      }
    });
  } catch (error) {
    // The same NSU twice means a duplicated answer for another transaction: stop and ask for review instead of recording money twice.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.$transaction(async tx => {
        const current = await tx.tefTransaction.findUniqueOrThrow({ where: { id: transactionId } });
        if (current.status === TefStatus.APPROVED) return current;
        const updated = await tx.tefTransaction.update({ where: { id: current.id }, data: { status: TefStatus.UNKNOWN, responseMessage: 'NSU já registrado em outra transação' } });
        await event(tx, current, current.status, TefStatus.UNKNOWN, 'NSU duplicado: aprovação não registrada; revisar com o provedor', actorUserId, { nsu: response.nsu });
        return updated;
      });
    }
    throw error;
  }
}

function validateApproval(transaction: TefTransaction, response: TefResponse): string | null {
  if (!response.providerRef) return 'sem identificador do provedor';
  if (transaction.providerRef && transaction.providerRef !== response.providerRef) return 'identificador diferente do já conhecido';
  if (response.amount !== undefined && !new Prisma.Decimal(response.amount).equals(transaction.amount)) return 'valor diferente do solicitado';
  if (CARD.includes(transaction.method) && (!response.nsu || !response.authorizationCode)) return 'NSU ou código de autorização ausente';
  return null;
}

// `operatorUserId` limits a non-financial profile (cashier) to the transactions it started itself.
export async function loadTransaction(tenantId: string, id: string, unitId?: string | null, operatorUserId?: string | null) {
  return prisma.tefTransaction.findFirst({ where: { id, tenantId, ...(unitId ? { unitId } : {}), ...(operatorUserId ? { operatorUserId } : {}) } });
}

async function adapterAndConfig(transaction: TefTransaction): Promise<{ adapter: TefAdapter; config: TefConfigView }> {
  const adapter = tefAdapters.get(transaction.provider);
  const config = await prisma.tefProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: transaction.tenantId, provider: transaction.provider } } });
  if (!adapter || !config) throw new TefError('Provedor TEF indisponível para consultar esta transação.', 501, 'TEF_PROVIDER_UNAVAILABLE');
  return { adapter, config: configView(config) };
}

// Asks the provider for the real state of an in-flight transaction (never resends the charge) and applies it.
export async function syncTransaction(transaction: TefTransaction, actorUserId?: string | null): Promise<TefTransaction> {
  const waiting = IN_FLIGHT.includes(transaction.status) || (transaction.status === TefStatus.APPROVED && transaction.reversalRef === 'IN_PROGRESS');
  if (!waiting) return transaction;
  const { adapter, config } = await adapterAndConfig(transaction);
  if (!adapter.query) throw new TefError('O provedor não oferece consulta de transação; confirme no portal do provedor.', 409, 'TEF_NO_QUERY');
  let response: TefResponse;
  try { response = await withTimeout(adapter.query(transaction.id, config)); } catch { throw new TefError('Não foi possível consultar o provedor agora. Tente novamente; a cobrança não foi reenviada.', 502, 'TEF_QUERY_FAILED'); }
  return applyResponse(transaction.id, response, actorUserId);
}

async function finaliseReversal(tx: Prisma.TransactionClient, transaction: TefTransaction, reversalRef: string | null, reason: string, userId: string | null) {
  if (transaction.paymentId) {
    await tx.payment.update({ where: { id: transaction.paymentId }, data: { status: PaymentStatus.REFUNDED } });
    await syncPromissory(tx, transaction.tenantId, transaction.orderId, 'refund');
  }
  const updated = await tx.tefTransaction.update({ where: { id: transaction.id }, data: { status: TefStatus.REVERSED, reversalRef, reversalReason: reason, reversedByUserId: userId, reversedAt: new Date() } });
  await event(tx, transaction, transaction.status, TefStatus.REVERSED, `Estorno confirmado: ${reason}`, userId, { reversalRef });
  await tx.auditLog.create({ data: { tenantId: transaction.tenantId, actorUserId: userId, action: 'TEF_PAYMENT_REVERSED', entityType: 'TefTransaction', entityId: transaction.id, metadata: { reversalRef, reason, orderId: transaction.orderId } } });
  return updated;
}

// Cancellation/reversal at the provider. The sale, financial and cash records only change after the provider confirms; the original transaction stays linked.
export async function reverseTransaction(transaction: TefTransaction, userId: string, reason: string) {
  const { adapter, config } = await adapterAndConfig(transaction);
  if (!adapter.cancel) throw new TefError('O provedor não oferece cancelamento por esta integração; cancele no portal do provedor.', 409, 'TEF_NO_CANCEL');
  const claimed = await prisma.tefTransaction.updateMany({ where: { id: transaction.id, tenantId: transaction.tenantId, status: TefStatus.APPROVED, reversalRef: null }, data: { reversalRef: 'IN_PROGRESS', reversalReason: reason } });
  if (claimed.count !== 1) throw new TefError('Somente transações aprovadas e ainda não estornadas podem ser canceladas.', 409, 'TEF_NOT_REVERSIBLE');
  let result;
  try { result = await withTimeout(adapter.cancel({ reference: transaction.id, providerRef: transaction.providerRef, nsu: transaction.nsu, amount: transaction.amount.toFixed(2) }, config)); }
  catch {
    await prisma.tefEvent.create({ data: { tenantId: transaction.tenantId, transactionId: transaction.id, fromStatus: TefStatus.APPROVED, toStatus: TefStatus.APPROVED, note: 'Resultado do estorno desconhecido; consulte o provedor (sincronizar)', actorUserId: userId } });
    throw new TefError('Não foi possível confirmar o estorno. Consulte a transação antes de repetir; nada foi alterado no financeiro.', 502, 'TEF_REVERSAL_UNKNOWN');
  }
  if (!result.ok) {
    await prisma.$transaction(async tx => {
      await tx.tefTransaction.update({ where: { id: transaction.id }, data: { reversalRef: null, reversalReason: null } });
      await event(tx, transaction, TefStatus.APPROVED, TefStatus.APPROVED, `Estorno recusado pelo provedor${result.message ? `: ${result.message}` : ''}`, userId);
    });
    throw new TefError(`Estorno recusado pelo provedor${result.message ? `: ${result.message}` : ''}.`, 409, 'TEF_REVERSAL_DENIED');
  }
  return serializable(prisma, async tx => {
    const fresh = await tx.tefTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    if (fresh.status === TefStatus.REVERSED) return fresh;
    return finaliseReversal(tx, fresh, result.reversalRef ?? null, reason, userId);
  });
}

// Undo ("desfazimento") of a charge that is not settled yet. The real state is queried first: if the provider already approved it, it is NOT undone here (it needs a reversal, with its own permission). Only a provider-confirmed cancellation closes it.
export async function undoTransaction(transaction: TefTransaction, userId: string, reason: string): Promise<{ transaction: TefTransaction; outcome: 'UNDONE' | 'APPROVED_USE_REVERSAL' | 'ALREADY_CLOSED' }> {
  if (!IN_FLIGHT.includes(transaction.status)) return { transaction, outcome: transaction.status === TefStatus.APPROVED ? 'APPROVED_USE_REVERSAL' : 'ALREADY_CLOSED' };
  const { adapter, config } = await adapterAndConfig(transaction);
  if (!adapter.cancel) throw new TefError('O provedor não oferece desfazimento por esta integração; resolva no portal do provedor.', 409, 'TEF_NO_CANCEL');
  const synced = await syncTransaction(transaction, userId).catch(() => transaction);
  if (synced.status === TefStatus.APPROVED) return { transaction: synced, outcome: 'APPROVED_USE_REVERSAL' };
  if (!IN_FLIGHT.includes(synced.status)) return { transaction: synced, outcome: 'ALREADY_CLOSED' };
  let result;
  try { result = await withTimeout(adapter.cancel({ reference: transaction.id, providerRef: transaction.providerRef, nsu: transaction.nsu, amount: transaction.amount.toFixed(2) }, config)); }
  catch { throw new TefError('Não foi possível confirmar o desfazimento no provedor. Consulte antes de repetir; a transação continua pendente.', 502, 'TEF_UNDO_UNKNOWN'); }
  if (!result.ok) throw new TefError(`O provedor não confirmou o desfazimento${result.message ? `: ${result.message}` : ''}. A transação continua pendente; consulte-a.`, 409, 'TEF_UNDO_DENIED');
  const updated = await prisma.$transaction(async tx => {
    const fresh = await tx.tefTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    if (!IN_FLIGHT.includes(fresh.status)) return fresh;
    const moved = await tx.tefTransaction.update({ where: { id: fresh.id }, data: { status: TefStatus.CANCELLED, completedAt: new Date(), reversalReason: reason } });
    await event(tx, fresh, fresh.status, TefStatus.CANCELLED, `Desfeita com confirmação do provedor: ${reason}`, userId, { reversalRef: result.reversalRef });
    await tx.auditLog.create({ data: { tenantId: fresh.tenantId, actorUserId: userId, action: 'TEF_TRANSACTION_UNDONE', entityType: 'TefTransaction', entityId: fresh.id, metadata: { reason, orderId: fresh.orderId } } });
    return moved;
  });
  return { transaction: updated, outcome: 'UNDONE' };
}

// Recovery sweep: asks the provider for the real state of every unresolved transaction older than `olderThanMinutes` (never resends a charge).
// An approval found here goes through the same validated path as any other approval, so the payment is recorded exactly once.
export async function recoverInFlight(tenantId: string, unitId: string | null | undefined, actorUserId: string | null, olderThanMinutes = 1, operatorUserId?: string | null) {
  const pending = await prisma.tefTransaction.findMany({
    where: { tenantId, ...(unitId ? { unitId } : {}), ...(operatorUserId ? { operatorUserId } : {}), status: { in: IN_FLIGHT }, createdAt: { lte: new Date(Date.now() - olderThanMinutes * 60_000) } },
    orderBy: { createdAt: 'asc' }, take: 50,
  });
  const summary = { checked: pending.length, approved: 0, denied: 0, closed: 0, stillPending: 0, failed: 0, approvedOrderIds: [] as string[] };
  for (const item of pending) {
    try {
      const updated = await syncTransaction(item, actorUserId);
      if (updated.status === TefStatus.APPROVED) { summary.approved++; summary.approvedOrderIds.push(updated.orderId); }
      else if (updated.status === TefStatus.DENIED) summary.denied++;
      else if (IN_FLIGHT.includes(updated.status)) summary.stillPending++;
      else summary.closed++;
    } catch { summary.failed++; }
  }
  return summary;
}

// Receipt text built from the validated transaction data. It is the RM copy, not the provider's original slip: only the data we hold is printed and nothing is invented.
export function receiptLines(transaction: TefTransaction, copy: 'CUSTOMER' | 'MERCHANT', header: { company: string; cnpj?: string | null }, columns = 48, reprint = false): string[] {
  const rule = '-'.repeat(columns);
  const center = (text: string) => centerLines(text, columns);
  const row = (label: string, value: string) => { const gap = columns - label.length - value.length; return gap >= 1 ? label + ' '.repeat(gap) + value : `${label} ${value}`.slice(0, columns); };
  const method = { CREDIT_CARD: 'CRÉDITO', DEBIT_CARD: 'DÉBITO', PIX: 'PIX', VOUCHER: 'VOUCHER' }[transaction.method as string] ?? transaction.method;
  const lines = [...center(header.company.toUpperCase()), ...(header.cnpj ? center(`CNPJ ${header.cnpj}`) : []), rule, ...center(copy === 'CUSTOMER' ? 'COMPROVANTE TEF - VIA CLIENTE' : 'COMPROVANTE TEF - VIA ESTABELECIMENTO')];
  if (transaction.simulated) lines.push(...center('*** SIMULAÇÃO - SEM VALOR ***'));
  if (reprint) lines.push(...center('*** REIMPRESSÃO ***'));
  lines.push(rule, row('Forma', `${method}${transaction.installments > 1 ? ` ${transaction.installments}x` : ''}`), row('Valor', `R$ ${transaction.amount.toFixed(2).replace('.', ',')}`));
  if (transaction.cardBrand) lines.push(row('Bandeira', transaction.cardBrand));
  if (transaction.nsu) lines.push(row('NSU', transaction.nsu));
  if (transaction.authorizationCode) lines.push(row('Autorização', transaction.authorizationCode));
  if (transaction.pixEndToEnd) lines.push('EndToEnd:', ...(transaction.pixEndToEnd.match(new RegExp(`.{1,${columns}}`, 'g')) ?? []));
  if (transaction.terminalId) lines.push(row('Terminal', transaction.terminalId));
  lines.push(row('Provedor', transaction.provider), row('Data', (transaction.completedAt ?? transaction.requestedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })), rule);
  if (copy === 'MERCHANT') lines.push('', ...center('Assinatura / visto'), '', rule);
  return lines;
}

// Reconciles approved TEF transactions with the payments recorded in the books. Approval is not bank settlement: settlement needs the acquirer's own data.
export async function reconcile(tenantId: string, from: Date, to: Date, unitId?: string | null) {
  const scope = { tenantId, ...(unitId ? { unitId } : {}) };
  const [transactions, payments, open] = await Promise.all([
    prisma.tefTransaction.findMany({ where: { ...scope, createdAt: { gte: from, lte: to } }, include: { payment: { select: { id: true, status: true, amount: true, method: true } } }, orderBy: { createdAt: 'asc' }, take: 20_000 }),
    prisma.payment.findMany({ where: { ...scope, paidAt: { gte: from, lte: to }, method: { in: [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD, PaymentMethod.PIX] } }, include: { tefTransaction: { select: { id: true } }, order: { select: { code: true } } }, take: 20_000 }),
    prisma.tefTransaction.count({ where: { ...scope, status: { in: IN_FLIGHT } } }),
  ]);
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: [...new Set(transactions.map(item => item.orderId))] }, tenantId }, select: { id: true, code: true } })).map(order => [order.id, order.code]));
  const divergences: { type: string; transactionId?: string; paymentId?: string; orderCode: string | null; detail: string }[] = [];
  const totals = new Map<string, { method: string; brand: string; approved: number; approvedAmount: number; reversed: number; reversedAmount: number; denied: number }>();
  for (const item of transactions) {
    const key = `${item.method}|${item.cardBrand ?? '—'}`;
    const row = totals.get(key) ?? { method: item.method, brand: item.cardBrand ?? '—', approved: 0, approvedAmount: 0, reversed: 0, reversedAmount: 0, denied: 0 };
    const amount = Number(item.amount);
    if (item.status === TefStatus.APPROVED) { row.approved++; row.approvedAmount += amount; }
    if (item.status === TefStatus.REVERSED) { row.reversed++; row.reversedAmount += amount; }
    if (item.status === TefStatus.DENIED) row.denied++;
    totals.set(key, row);
    const orderCode = orders.get(item.orderId) ?? null;
    if (item.status === TefStatus.APPROVED && (!item.payment || item.payment.status !== PaymentStatus.CONFIRMED)) divergences.push({ type: 'APPROVED_WITHOUT_PAYMENT', transactionId: item.id, orderCode, detail: 'Transação aprovada sem pagamento confirmado no RM.' });
    if (item.status === TefStatus.APPROVED && item.payment && !item.payment.amount.equals(item.amount)) divergences.push({ type: 'AMOUNT_MISMATCH', transactionId: item.id, paymentId: item.payment.id, orderCode, detail: `TEF ${item.amount.toFixed(2)} × pagamento ${item.payment.amount.toFixed(2)}.` });
    if (item.status === TefStatus.REVERSED && item.payment?.status === PaymentStatus.CONFIRMED) divergences.push({ type: 'REVERSED_STILL_PAID', transactionId: item.id, paymentId: item.payment.id, orderCode, detail: 'Estornada no provedor, mas o pagamento continua confirmado.' });
    if (IN_FLIGHT.includes(item.status)) divergences.push({ type: 'UNRESOLVED', transactionId: item.id, orderCode, detail: `Transação ${item.status} sem desfecho confirmado.` });
  }
  const manual = payments.filter(payment => !payment.tefTransaction && payment.status === PaymentStatus.CONFIRMED);
  for (const payment of manual) divergences.push({ type: 'PAYMENT_WITHOUT_TEF', paymentId: payment.id, orderCode: payment.order?.code ?? null, detail: `Pagamento ${payment.method} de ${payment.amount.toFixed(2)} lançado sem transação TEF (maquininha avulsa ou digitação manual).` });
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    period: { from, to }, unresolved: open,
    totals: [...totals.values()].map(row => ({ ...row, approvedAmount: round(row.approvedAmount), reversedAmount: round(row.reversedAmount) })),
    divergences, manualPayments: manual.length,
    notice: 'Aprovação não é liquidação bancária: valores liquidados só podem ser conciliados com os dados de liquidação do provedor/adquirente.',
  };
}

// `withAmounts` is false for profiles without financial permission: they get counts only, never sums or per-transaction values.
export async function monitor(tenantId: string, unitId: string | null | undefined, withAmounts: boolean, staleMinutes = 5) {
  const scope = { tenantId, ...(unitId ? { unitId } : {}) };
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [byStatus, stale] = await Promise.all([
    prisma.tefTransaction.groupBy({ by: ['status'], where: { ...scope, createdAt: { gte: since } }, _count: true, _sum: { amount: true } }),
    prisma.tefTransaction.findMany({ where: { ...scope, status: { in: IN_FLIGHT }, createdAt: { lte: new Date(Date.now() - staleMinutes * 60_000) } }, select: { id: true, orderId: true, status: true, provider: true, amount: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50 }),
  ]);
  return {
    since, withAmounts,
    byStatus: byStatus.map(row => ({ status: row.status, count: row._count, ...(withAmounts ? { amount: Number(row._sum.amount ?? 0) } : {}) })),
    stale: stale.map(({ amount, ...rest }) => (withAmounts ? { ...rest, amount } : rest)),
  };
}
