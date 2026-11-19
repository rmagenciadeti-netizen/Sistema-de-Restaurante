import { Prisma, ProductStockMovementType, type MigrationRecord, type MigrationSession } from '@prisma/client';
import { prisma } from '../prisma';
import { phoneVariants } from './normalize';
import { existingEntry, logEvent, MigrationError, refreshSummary, saleCode } from './service';
import { ENTITIES, ENTITY_KEYS, entryType, type EntityKey } from './targets';
import type { NormalizedValues } from './pipeline';

const json = (value: unknown) => value as Prisma.InputJsonValue;
export const STALE_RUNNING_MS = 2 * 60 * 1000;
export const BATCH_SIZE = 200;

export class RecordFailure extends Error {}
// Thrown by test hooks (or infrastructure faults) to model a crash in the middle of an import; the run is left resumable.
export class RunInterrupted extends Error {}

export type RunHooks = { beforeRecord?: (record: MigrationRecord) => void | Promise<void> };
export type Actor = { id: string; label: string };

const text = (values: NormalizedValues, key: string) => typeof values[key] === 'string' ? values[key] as string : null;
const decimal = (values: NormalizedValues, key: string) => { const value = text(values, key); return value === null ? null : new Prisma.Decimal(value); };

// `issue` flags something the operator should look at without failing the record (nothing is invented to fill the gap).
type Outcome = { id: string; created: boolean; issue?: { field: string; code: string; message: string } };
const eq = (name: string) => ({ equals: name, mode: 'insensitive' as const });
// Payment method written in the old system -> RM method; unknown wording stays OTHER and a missing one records no payment.
function paymentMethodOf(label: string | null): 'CASH' | 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'VOUCHER' | 'OTHER' | null {
  const value = (label ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!value) return null;
  if (/pix/.test(value)) return 'PIX';
  if (/credit|credito|parcel/.test(value)) return 'CREDIT_CARD';
  if (/debit|debito/.test(value)) return 'DEBIT_CARD';
  if (/dinheiro|cash|especie|money/.test(value)) return 'CASH';
  if (/vale|voucher|ticket|refeicao|alimentacao|sodexo|alelo|vr|va/.test(value)) return 'VOUCHER';
  return 'OTHER';
}
const noon = (iso: string | null) => iso ? new Date(`${iso}T12:00:00.000Z`) : null;
const accepted = (record: MigrationRecord, field: string) => ((record.issues ?? []) as unknown as { field: string; code: string }[]).some(issue => issue.field === field && (issue.code === 'unresolved_reference' || issue.code === 'ambiguous_reference'));
// A link that cannot be resolved is only dropped when the operator approved a record flagged for exactly that; otherwise the record fails visibly.
function link(id: string | null, record: MigrationRecord, field: string, label: string, name: string | null): string | null {
  if (id) return id;
  if (name === null || accepted(record, field)) return null;
  throw new RecordFailure(`Relacionamento não resolvido: ${label} "${name}" não existe no RM Restaurante.`);
}
async function findSupplier(tx: Prisma.TransactionClient, tenantId: string, name: string | null, document: string | null) {
  if (document) { const byDocument = await tx.supplier.findFirst({ where: { tenantId, document }, select: { id: true } }); if (byDocument) return byDocument.id; }
  return name ? (await tx.supplier.findFirst({ where: { tenantId, name: eq(name) }, select: { id: true } }))?.id ?? null : null;
}
async function findCustomer(tx: Prisma.TransactionClient, tenantId: string, name: string | null, phone: string | null, document: string | null) {
  if (phone) { const byPhone = await tx.customer.findFirst({ where: { tenantId, phone: { in: phoneVariants(phone) } }, select: { id: true } }); if (byPhone) return byPhone.id; }
  if (document) { const byDocument = await tx.customer.findFirst({ where: { tenantId, document }, select: { id: true } }); if (byDocument) return byDocument.id; }
  if (!name) return null;
  const byName = await tx.customer.findMany({ where: { tenantId, name: eq(name) }, select: { id: true }, take: 2 });
  return byName.length === 1 ? byName[0].id : null;
}

async function importRecord(tx: Prisma.TransactionClient, session: MigrationSession, record: MigrationRecord, actor: Actor): Promise<Outcome> {
  const tenantId = session.tenantId; const unitId = session.unitId ?? null; const values = record.normalized as NormalizedValues;
  const active = typeof values.active === 'boolean' ? values.active : true;
  switch (record.entity as EntityKey) {
    case 'CATEGORY': {
      const name = text(values, 'name'); if (!name) throw new RecordFailure('Nome da categoria ausente.');
      const existing = await tx.productCategory.findFirst({ where: { tenantId, name: eq(name) } });
      if (existing) return { id: existing.id, created: false };
      const parentName = text(values, 'parentName');
      const parent = parentName ? await tx.productCategory.findFirst({ where: { tenantId, name: eq(parentName) }, select: { id: true } }) : null;
      if (parentName && !parent) throw new RecordFailure(`Relacionamento não resolvido: categoria superior "${parentName}" não existe.`);
      return { id: (await tx.productCategory.create({ data: { tenantId, name, parentId: parent?.id ?? null } })).id, created: true };
    }
    case 'FIN_CATEGORY': {
      const name = text(values, 'name'); const type = text(values, 'type') as 'INCOME' | 'EXPENSE' | null; if (!name || !type) throw new RecordFailure('Nome e tipo da categoria financeira são obrigatórios.');
      const existing = await tx.financialCategory.findFirst({ where: { tenantId, type, name: eq(name) } });
      if (existing) return { id: existing.id, created: false };
      const parentName = text(values, 'parentName');
      const parent = parentName ? await tx.financialCategory.findFirst({ where: { tenantId, type, name: eq(parentName) }, select: { id: true } }) : null;
      if (parentName && !parent) throw new RecordFailure(`Relacionamento não resolvido: categoria financeira superior "${parentName}" não existe.`);
      return { id: (await tx.financialCategory.create({ data: { tenantId, type, name, parentId: parent?.id ?? null } })).id, created: true };
    }
    case 'COST_CENTER': {
      const name = text(values, 'name'); if (!name) throw new RecordFailure('Nome do centro de custo ausente.');
      const existing = await tx.costCenter.findFirst({ where: { tenantId, name: eq(name) } });
      return existing ? { id: existing.id, created: false } : { id: (await tx.costCenter.create({ data: { tenantId, name, code: text(values, 'code'), active } })).id, created: true };
    }
    case 'BANK_ACCOUNT': {
      const name = text(values, 'name'); if (!name) throw new RecordFailure('Nome da conta bancária ausente.');
      const existing = await tx.bankAccount.findFirst({ where: { tenantId, name: eq(name) } });
      if (existing) return { id: existing.id, created: false };
      const account = await tx.bankAccount.create({ data: { tenantId, name, bank: text(values, 'bank'), agency: text(values, 'agency'), accountNumber: text(values, 'accountNumber'), initialBalance: decimal(values, 'initialBalance') ?? 0, initialBalanceAt: noon(text(values, 'initialBalanceAt')), active } });
      return { id: account.id, created: true };
    }
    case 'PRODUCT': {
      const name = text(values, 'name'); const price = decimal(values, 'price');
      if (!name || price === null) throw new RecordFailure('Nome e preço são obrigatórios.');
      const code = text(values, 'code'); const barcode = text(values, 'barcode');
      if (code || barcode) {
        const existing = await tx.product.findFirst({ where: { tenantId, OR: [...(code ? [{ code }] : []), ...(barcode ? [{ barcode }] : [])] }, select: { id: true } });
        if (existing) return { id: existing.id, created: false };
      }
      let categoryId: string | null = null;
      const categoryName = text(values, 'subcategoryName') ?? text(values, 'categoryName');
      if (categoryName) {
        const category = await tx.productCategory.findFirst({ where: { tenantId, name: eq(categoryName) }, select: { id: true } });
        if (!category) throw new RecordFailure(`Relacionamento não resolvido: categoria "${categoryName}" não existe no RM Restaurant.`);
        categoryId = category.id;
      }
      const supplierName = text(values, 'supplierName');
      const supplierId = supplierName ? link(await findSupplier(tx, tenantId, supplierName, text(values, 'supplierDocument')), record, 'supplierName', 'Fornecedor', supplierName) : null;
      const stock = decimal(values, 'stockQuantity');
      const product = await tx.product.create({ data: {
        tenantId, name, code, barcode, description: text(values, 'description'), price, cost: decimal(values, 'cost'), categoryId, supplierId,
        ...(text(values, 'measureUnit') ? { measureUnit: text(values, 'measureUnit')! } : {}), active,
        stockControlled: stock !== null, stockQuantity: stock ?? 0, stockMin: decimal(values, 'stockMin'), ncm: text(values, 'ncm'),
        prepTimeMinutes: text(values, 'prepTimeMinutes') ? Number(text(values, 'prepTimeMinutes')) : null,
      } });
      // Opening balance: same ADJUSTMENT movement the product form writes for an initial stock (no historical movements are invented).
      if (stock !== null && stock.gt(0)) await tx.productStockMovement.create({ data: { tenantId, unitId, productId: product.id, type: ProductStockMovementType.ADJUSTMENT, quantity: stock, reference: `migration:${session.id}`, note: 'Abertura de estoque (saldo inicial importado pela migração de dados)', actorUserId: actor.id } });
      return { id: product.id, created: true };
    }
    case 'CUSTOMER': {
      const name = text(values, 'name'); const phone = text(values, 'phone') ?? text(values, 'whatsapp');
      if (!name || !phone) throw new RecordFailure('Nome e telefone são obrigatórios.');
      const document = text(values, 'document');
      const existing = await tx.customer.findFirst({ where: { tenantId, OR: [{ phone: { in: phoneVariants(phone) } }, ...(document ? [{ document }] : [])] }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
      // Marketing consent is never inferred from a legacy system.
      const customer = await tx.customer.create({ data: { tenantId, name, phone, whatsapp: text(values, 'whatsapp'), email: text(values, 'email'), document, address: text(values, 'address'), zip: text(values, 'zip'), city: text(values, 'city'), state: text(values, 'state'), notes: text(values, 'notes'), active, marketingConsent: false } });
      return { id: customer.id, created: true };
    }
    case 'SUPPLIER': {
      const name = text(values, 'name'); if (!name) throw new RecordFailure('Razão social do fornecedor ausente.');
      const existing = await findSupplier(tx, tenantId, name, text(values, 'document'));
      if (existing) return { id: existing, created: false };
      const supplier = await tx.supplier.create({ data: { tenantId, name, tradeName: text(values, 'tradeName'), document: text(values, 'document'), stateRegistration: text(values, 'stateRegistration'), phone: text(values, 'phone'), email: text(values, 'email'), address: text(values, 'address'), zip: text(values, 'zip'), city: text(values, 'city'), state: text(values, 'state'), contactName: text(values, 'contactName'), notes: text(values, 'notes'), active } });
      return { id: supplier.id, created: true };
    }
    case 'EMPLOYEE': {
      const fullName = text(values, 'fullName'); if (!fullName) throw new RecordFailure('Nome do funcionário ausente.');
      const cpf = text(values, 'cpf');
      const existing = await tx.employee.findFirst({ where: { tenantId, OR: [...(cpf ? [{ cpf }] : []), { fullName: eq(fullName) }] }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
      // Registration only: no user, password or permission is created (access follows the RM invitation flow).
      const employee = await tx.employee.create({ data: { tenantId, unitId, fullName, cpf, phone: text(values, 'phone'), email: text(values, 'email'), position: text(values, 'position'), status: active ? 'ACTIVE' : 'INACTIVE', admissionDate: noon(text(values, 'admissionDate')) } });
      return { id: employee.id, created: true };
    }
    case 'SALE': {
      const number = text(values, 'saleNumber'); const soldAt = noon(text(values, 'soldAt')); const total = decimal(values, 'total');
      if (!number || !soldAt || total === null) throw new RecordFailure('Número, data e valor total da venda são obrigatórios.');
      const code = saleCode(number);
      const existing = await tx.order.findFirst({ where: { tenantId, code }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
      const customerName = text(values, 'customerName'); const customerPhone = text(values, 'customerPhone');
      const customerId = customerName || customerPhone ? await findCustomer(tx, tenantId, customerName, customerPhone, null) : null;
      const discount = decimal(values, 'discount') ?? new Prisma.Decimal(0); const serviceFee = decimal(values, 'serviceFee') ?? new Prisma.Decimal(0); const deliveryFee = decimal(values, 'deliveryFee') ?? new Prisma.Decimal(0);
      const cancelled = /cancel|estorn|devolv/i.test(text(values, 'status') ?? '');
      const subtotal = total.sub(serviceFee).sub(deliveryFee).add(discount);
      if (subtotal.lt(0)) throw new RecordFailure('Taxas e descontos são maiores que o valor total da venda.');
      // Historical record only: no stock movement, production ticket, print job or fiscal document is created, and the original date is kept.
      const order = await tx.order.create({ data: { tenantId, unitId, code, channel: 'POS', status: cancelled ? 'CANCELLED' : 'COMPLETED', customerName: customerName ?? null, customerId, subtotal, serviceFee, deliveryFee, discount, total, createdAt: soldAt, releasedAt: soldAt } });
      const method = paymentMethodOf(text(values, 'paymentMethod'));
      if (!cancelled && method) await tx.payment.create({ data: { tenantId, unitId, orderId: order.id, method, amount: total, reference: `migration:${session.id}`, paidAt: soldAt } });
      const issue = cancelled ? undefined : !method ? { field: 'paymentMethod', code: 'no_payment_recorded', message: 'Venda importada sem forma de pagamento: nenhum pagamento foi registrado (nada foi presumido). Lance o recebimento manualmente se necessário.' } : undefined;
      return { id: order.id, created: true, issue };
    }
    case 'SALE_ITEM': {
      const number = text(values, 'saleNumber'); const quantity = decimal(values, 'quantity'); const unitPrice = decimal(values, 'unitPrice');
      if (!number || quantity === null || unitPrice === null || quantity.lte(0)) throw new RecordFailure('Venda, quantidade e preço unitário são obrigatórios.');
      const order = await tx.order.findFirst({ where: { tenantId, code: saleCode(number) }, select: { id: true } });
      if (!order) throw new RecordFailure(`Relacionamento não resolvido: a venda "${number}" não foi importada (importe as vendas antes dos itens).`);
      const code = text(values, 'productCode'); const name = text(values, 'productName');
      const product = code || name
        ? await tx.product.findFirst({ where: { tenantId, OR: [...(code ? [{ code }, { barcode: code }] : []), ...(name ? [{ name: eq(name) }] : [])] }, select: { id: true } })
        : null;
      if (!product) throw new RecordFailure(`Relacionamento não resolvido: produto "${code ?? name ?? ''}" não existe no RM Restaurante.`);
      const total = decimal(values, 'total') ?? quantity.mul(unitPrice).toDecimalPlaces(2);
      const same = await tx.orderItem.findFirst({ where: { orderId: order.id, productId: product.id, quantity, unitPrice }, select: { id: true } });
      if (same) return { id: same.id, created: false };
      // The cost at the time of an old sale is unknown, so it is left empty instead of being estimated with today's cost.
      const item = await tx.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity, unitPrice, total, unitCost: null } });
      return { id: item.id, created: true };
    }
    case 'PAYABLE': case 'RECEIVABLE': {
      const entity = record.entity as 'PAYABLE' | 'RECEIVABLE'; const type = entryType(entity);
      const description = text(values, 'description'); const amount = decimal(values, 'amount');
      if (!description || amount === null) throw new RecordFailure('Descrição e valor original são obrigatórios.');
      const duplicate = await existingEntry(tenantId, entity, values);
      if (duplicate) return { id: duplicate.id, created: false };
      const supplierName = text(values, 'supplierName'); const customerName = text(values, 'customerName');
      const supplierId = supplierName ? link(await findSupplier(tx, tenantId, supplierName, text(values, 'supplierDocument')), record, 'supplierName', 'Fornecedor', supplierName) : null;
      const customerId = customerName ? link(await findCustomer(tx, tenantId, customerName, text(values, 'customerPhone'), text(values, 'customerDocument')), record, 'customerName', 'Cliente', customerName) : null;
      const structural = async (field: string, label: string, find: (name: string) => Promise<{ id: string } | null>) => { const name = text(values, field); if (!name) return null; const found = await find(name); if (!found) throw new RecordFailure(`Relacionamento não resolvido: ${label} "${name}" não existe no RM Restaurante.`); return found.id; };
      const costCenterId = await structural('costCenterName', 'Centro de custo', name => tx.costCenter.findFirst({ where: { tenantId, name: eq(name) }, select: { id: true } }));
      const bankAccountId = await structural('bankAccountName', 'Conta bancária', name => tx.bankAccount.findFirst({ where: { tenantId, name: eq(name) }, select: { id: true } }));
      const categoryRef = text(values, 'subcategoryName') ?? text(values, 'categoryName');
      const category = categoryRef ? await tx.financialCategory.findFirst({ where: { tenantId, type, name: eq(categoryRef) }, select: { name: true } }) : null;
      if (categoryRef && !category) throw new RecordFailure(`Relacionamento não resolvido: categoria financeira "${categoryRef}" não existe no RM Restaurante.`);
      const partyName = supplierName ?? customerName;
      const status = text(values, 'status') === 'PAID' ? 'PAID' : text(values, 'status') === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
      const entry = await tx.financialEntry.create({ data: {
        tenantId, unitId, type, description, amount, paidAmount: decimal(values, 'paidAmount') ?? 0, interestAmount: decimal(values, 'interestAmount') ?? 0, discountAmount: decimal(values, 'discountAmount') ?? 0,
        status, category: category?.name ?? null, supplierId, customerId, debtorName: partyName && !supplierId && !customerId ? partyName : null,
        documentNumber: text(values, 'documentNumber'), installmentNumber: text(values, 'installmentNumber') ? Number(text(values, 'installmentNumber')) : null, installmentCount: text(values, 'installmentCount') ? Number(text(values, 'installmentCount')) : null,
        // Dates are the historical ones from the source (noon UTC keeps the calendar day in every Brazilian time zone).
        issuedAt: noon(text(values, 'issuedAt')), dueAt: noon(text(values, 'dueAt')), settledAt: status === 'PAID' ? noon(text(values, 'settledAt')) : null,
        costCenterId, bankAccountId, paymentMethod: text(values, 'paymentMethod'), notes: text(values, 'notes'),
      } });
      return { id: entry.id, created: true };
    }
  }
}

async function processRecord(session: MigrationSession, record: MigrationRecord, actor: Actor, hooks?: RunHooks) {
  await hooks?.beforeRecord?.(record);
  try {
    await prisma.$transaction(async tx => {
      if (record.targetId) { await tx.migrationRecord.update({ where: { id: record.id }, data: { status: 'IMPORTED', error: null } }); return; }
      const outcome = await importRecord(tx, session, record, actor);
      await tx.migrationRecord.update({ where: { id: record.id }, data: outcome.created
        ? { status: 'IMPORTED', targetId: outcome.id, targetCreated: true, error: null, ...(outcome.issue ? { issues: json([...((record.issues ?? []) as object[]), { ...outcome.issue, severity: 'review' }]) } : {}) }
        : { status: 'DUPLICATE', targetId: outcome.id, targetCreated: false, approved: false, issues: json([...((record.issues ?? []) as object[]), { field: 'key', severity: 'info', code: 'exists', message: 'Já existia no RM Restaurant no momento da importação; nada foi alterado.' }]) } });
    });
  } catch (error) {
    if (error instanceof RecordFailure || (error instanceof Prisma.PrismaClientKnownRequestError && error.code !== 'P2034')) {
      const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      await prisma.migrationRecord.update({ where: { id: record.id }, data: duplicate
        ? { status: 'DUPLICATE', approved: false, error: null, issues: json([...((record.issues ?? []) as object[]), { field: 'key', severity: 'info', code: 'exists', message: 'Chave única já existente; registro não duplicado.' }]) }
        : { status: 'FAILED', approved: false, error: (error instanceof RecordFailure ? error.message : `Falha de banco de dados (${(error as Prisma.PrismaClientKnownRequestError).code}).`).slice(0, 500) } });
      return;
    }
    throw error;
  }
}

export async function runMigration(session: MigrationSession, actor: Actor, options: { batchSize?: number; hooks?: RunHooks } = {}) {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
  const resumed = session.status !== 'APPROVED';
  try {
    const claimed = await prisma.migrationSession.updateMany({
      where: { id: session.id, tenantId: session.tenantId, OR: [{ status: 'APPROVED' }, { status: 'INTERRUPTED' }, { status: 'RUNNING', updatedAt: { lt: staleBefore } }] },
      data: { status: 'RUNNING', startedAt: session.startedAt ?? new Date(), finishedAt: null, cancelRequested: false },
    });
    if (claimed.count !== 1) throw new MigrationError('A sessão precisa estar aprovada (ou interrompida) para ser executada.');
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new MigrationError('Já existe outra migração em execução para este restaurante.');
    throw error;
  }
  await logEvent(session, actor.id, resumed ? 'RESUMED' : 'STARTED', resumed ? 'Execução retomada a partir dos registros ainda pendentes.' : 'Execução iniciada.', { batchSize });
  const processed = { batches: 0, records: 0 }; let stopped = false;
  // A cancel request is only honoured by the runner itself (between records), so nothing keeps writing after the session is reported as stopped.
  const shouldStop = async () => { const live = await prisma.migrationSession.findUnique({ where: { id: session.id }, select: { status: true, cancelRequested: true } }); return live?.status !== 'RUNNING' || live.cancelRequested; };
  try {
    for (const entity of [...ENTITY_KEYS].sort((a, b) => ENTITIES[a].order - ENTITIES[b].order)) {
      for (;;) {
        if (await shouldStop()) { stopped = true; break; }
        const batch = await prisma.migrationRecord.findMany({ where: { sessionId: session.id, entity, approved: true, status: { in: ['VALID', 'DIVERGENT'] } }, orderBy: [{ seq: 'asc' }, { rowIndex: 'asc' }], take: batchSize });
        if (batch.length === 0) break;
        let done = 0;
        for (const record of batch) {
          if (await shouldStop()) { stopped = true; break; }
          await processRecord(session, record, actor, options.hooks); done++;
        }
        processed.records += done;
        if (done > 0) { processed.batches++; await logEvent(session, actor.id, 'BATCH_DONE', `Lote ${processed.batches} (${entity}): ${done} registro(s) processados.`, { entity, size: done }); await refreshSummary(session.id); }
        if (stopped) break;
      }
      if (stopped) break;
    }
  } catch (error) {
    await prisma.migrationSession.updateMany({ where: { id: session.id, status: 'RUNNING' }, data: { status: 'INTERRUPTED', outcome: 'INTERRUPTED' } });
    await logEvent(session, actor.id, 'INTERRUPTED', `Execução interrompida: ${error instanceof Error ? error.message : 'erro desconhecido'}. Pode ser retomada sem duplicar registros.`);
    if (error instanceof RunInterrupted) return { status: 'INTERRUPTED' as const, ...processed };
    throw error;
  }
  if (stopped) {
    await prisma.migrationSession.updateMany({ where: { id: session.id, status: 'RUNNING' }, data: { status: 'CANCELLED', cancelRequested: false, outcome: 'INTERRUPTED', finishedAt: new Date() } });
    await logEvent(session, actor.id, 'STOPPED', 'Execução parada por solicitação do operador.', processed);
    await refreshSummary(session.id, { financial: true });
    return { status: 'CANCELLED' as const, ...processed };
  }
  const validation = await validateSession(session);
  await refreshSummary(session.id, { financial: true });
  await prisma.migrationSession.updateMany({ where: { id: session.id, status: 'RUNNING' }, data: { status: 'COMPLETED', outcome: validation.outcome, validation: json(validation), finishedAt: new Date() } });
  await logEvent(session, actor.id, 'COMPLETED', `Migração finalizada: ${OUTCOME_LABEL[validation.outcome]}.`, { outcome: validation.outcome, counts: validation.counts });
  await prisma.auditLog.create({ data: { tenantId: session.tenantId, actorUserId: actor.id, action: 'MIGRATION_COMPLETED', entityType: 'MigrationSession', entityId: session.id, metadata: { outcome: validation.outcome, counts: validation.counts } } });
  return { status: 'COMPLETED' as const, outcome: validation.outcome, ...processed };
}

// ---- Post-migration validation (section 15) ----
export const OUTCOME_LABEL: Record<string, string> = {
  VALIDATED: 'Concluída e validada', WITH_CAVEATS: 'Concluída com ressalvas', PARTIAL: 'Parcialmente concluída', INTERRUPTED: 'Interrompida', FAILED_VALIDATION: 'Reprovada na validação',
};
export type Check = { name: string; ok: boolean; detail: string };
export type Validation = { outcome: 'VALIDATED' | 'WITH_CAVEATS' | 'PARTIAL' | 'INTERRUPTED' | 'FAILED_VALIDATION'; checks: Check[]; counts: Record<string, number>; alerts: string[]; validatedAt: string };

const chunk = <T>(items: T[], size = 1000) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export async function validateSession(session: MigrationSession): Promise<Validation> {
  const { id: sessionId, tenantId } = session;
  const grouped = await prisma.migrationRecord.groupBy({ by: ['status', 'approved'], where: { sessionId }, _count: true });
  const count = (predicate: (row: typeof grouped[number]) => boolean) => grouped.filter(predicate).reduce((sum, row) => sum + row._count, 0);
  const counts = {
    read: count(() => true), imported: count(row => row.status === 'IMPORTED'), duplicates: count(row => row.status === 'DUPLICATE'), rejected: count(row => row.status === 'REJECTED'),
    failed: count(row => row.status === 'FAILED'), ignored: count(row => row.status === 'IGNORED'), reverted: count(row => row.status === 'REVERTED'),
    pendingDivergences: count(row => row.status === 'DIVERGENT' && !row.approved), notRun: count(row => row.approved && ['VALID', 'DIVERGENT'].includes(row.status)),
  };
  const checks: Check[] = [];
  // Imported records are verified in pages (a migration can hold >100k rows): existence, values and links in the destination database.
  const verify = new Map<EntityKey, { total: number; found: number; bad: Record<string, number> }>();
  const bump = (entity: EntityKey, key: string) => { const bucket = verify.get(entity)!; bucket.bad[key] = (bucket.bad[key] ?? 0) + 1; };
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.migrationRecord.findMany({ where: { sessionId, status: 'IMPORTED', targetCreated: true, targetId: { not: null } }, orderBy: { id: 'asc' }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, entity: true, targetId: true, normalized: true, issues: true } });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    for (const entity of ENTITY_KEYS) {
      const part = page.filter(record => record.entity === entity); if (part.length === 0) continue;
      const bucket = verify.get(entity) ?? verify.set(entity, { total: 0, found: 0, bad: {} }).get(entity)!; bucket.total += part.length;
      const ids = part.map(record => record.targetId!); const where = { tenantId, id: { in: ids } };
      const hasIssue = (record: { issues: unknown }, field: string) => ((record.issues ?? []) as unknown as { field: string; code: string }[]).some(issue => issue.field === field && issue.code.endsWith('_reference'));
      if (entity === 'PRODUCT') {
        const rows = await prisma.product.findMany({ where, select: { id: true, name: true, price: true, stockQuantity: true, categoryId: true, supplierId: true } }); const byId = new Map(rows.map(row => [row.id, row])); bucket.found += rows.length;
        for (const record of part) {
          const row = byId.get(record.targetId!); if (!row) continue; const values = record.normalized as NormalizedValues;
          if (!row.name.trim()) bump(entity, 'required');
          if (!row.price.equals(new Prisma.Decimal(text(values, 'price') ?? '0'))) bump(entity, 'price');
          if (text(values, 'stockQuantity') !== null && !row.stockQuantity.equals(new Prisma.Decimal(text(values, 'stockQuantity')!))) bump(entity, 'stock');
          if ((text(values, 'categoryName') !== null || text(values, 'subcategoryName') !== null) && !row.categoryId) bump(entity, 'category');
          if (text(values, 'supplierName') !== null && !row.supplierId && !hasIssue(record, 'supplierName')) bump(entity, 'supplier');
        }
      } else if (entity === 'PAYABLE' || entity === 'RECEIVABLE') {
        const rows = await prisma.financialEntry.findMany({ where, select: { id: true, amount: true, paidAmount: true, interestAmount: true, discountAmount: true, status: true, dueAt: true, issuedAt: true, settledAt: true, supplierId: true, customerId: true, costCenterId: true, bankAccountId: true, category: true, installmentNumber: true } }); const byId = new Map(rows.map(row => [row.id, row])); bucket.found += rows.length;
        const day = (date: Date | null) => date ? date.toISOString().slice(0, 10) : null;
        for (const record of part) {
          const row = byId.get(record.targetId!); if (!row) continue; const values = record.normalized as NormalizedValues;
          if (!row.amount.equals(new Prisma.Decimal(text(values, 'amount') ?? '0')) || !row.paidAmount.equals(new Prisma.Decimal(text(values, 'paidAmount') ?? '0'))) bump(entity, 'value');
          if (row.status !== text(values, 'status')) bump(entity, 'status');
          if (day(row.dueAt) !== text(values, 'dueAt') || day(row.issuedAt) !== text(values, 'issuedAt') || day(row.settledAt) !== (text(values, 'status') === 'PAID' ? text(values, 'settledAt') : null)) bump(entity, 'date');
          if ((text(values, 'supplierName') !== null && !row.supplierId && !hasIssue(record, 'supplierName')) || (text(values, 'customerName') !== null && !row.customerId && !hasIssue(record, 'customerName')) || (text(values, 'costCenterName') !== null && !row.costCenterId) || (text(values, 'bankAccountName') !== null && !row.bankAccountId) || ((text(values, 'categoryName') !== null || text(values, 'subcategoryName') !== null) && !row.category)) bump(entity, 'link');
          if (text(values, 'installmentNumber') !== null && row.installmentNumber !== Number(text(values, 'installmentNumber'))) bump(entity, 'installment');
        }
      } else if (entity === 'BANK_ACCOUNT') {
        const rows = await prisma.bankAccount.findMany({ where, select: { id: true, initialBalance: true } }); const byId = new Map(rows.map(row => [row.id, row])); bucket.found += rows.length;
        for (const record of part) { const row = byId.get(record.targetId!); if (row && !row.initialBalance.equals(new Prisma.Decimal(text(record.normalized as NormalizedValues, 'initialBalance') ?? '0'))) bump(entity, 'balance'); }
      } else {
        bucket.found += entity === 'CUSTOMER' ? await prisma.customer.count({ where }) : entity === 'SUPPLIER' ? await prisma.supplier.count({ where }) : entity === 'CATEGORY' ? await prisma.productCategory.count({ where }) : entity === 'EMPLOYEE' ? await prisma.employee.count({ where }) : entity === 'SALE' ? await prisma.order.count({ where }) : entity === 'SALE_ITEM' ? await prisma.orderItem.count({ where: { id: { in: ids }, order: { tenantId } } }) : entity === 'FIN_CATEGORY' ? await prisma.financialCategory.count({ where }) : await prisma.costCenter.count({ where });
      }
    }
    if (page.length < 500) break;
  }
  for (const [entity, bucket] of verify) {
    const label = ENTITIES[entity].label.toLowerCase();
    checks.push({ name: `Quantidade de ${label}`, ok: bucket.found === bucket.total, detail: `${bucket.found} de ${bucket.total} registros importados existem no destino.` });
    const rule = (key: string, name: string, okText: string, badText: string) => checks.push({ name, ok: !bucket.bad[key], detail: bucket.bad[key] ? `${bucket.bad[key]} ${badText}` : okText });
    if (entity === 'PRODUCT') {
      rule('price', 'Preços e valores', 'Todos os preços conferem com os valores aprovados.', 'produto(s) com preço diferente do aprovado.');
      rule('stock', 'Saldos de estoque', 'Todos os saldos conferem.', 'produto(s) com saldo divergente.');
      rule('category', 'Integridade referencial (produto → categoria)', 'Todas as categorias foram vinculadas.', 'produto(s) sem a categoria esperada.');
      rule('supplier', 'Integridade referencial (produto → fornecedor)', 'Todos os fornecedores esperados foram vinculados.', 'produto(s) sem o fornecedor esperado.');
      rule('required', 'Campos obrigatórios', 'Nenhum campo obrigatório vazio.', 'registro(s) sem nome.');
    }
    if (entity === 'PAYABLE' || entity === 'RECEIVABLE') {
      const kind = entity === 'PAYABLE' ? 'contas a pagar' : 'contas a receber';
      rule('value', `Valores financeiros (${kind})`, 'Valor original e valor baixado conferem com o aprovado.', 'lançamento(s) com valor diferente do aprovado.');
      rule('status', `Situações (${kind})`, 'Situações conferem.', 'lançamento(s) com situação diferente.');
      rule('date', `Datas históricas (${kind})`, 'Emissão, vencimento e baixa preservados.', 'lançamento(s) com data diferente da origem.');
      rule('link', `Relacionamentos (${kind})`, 'Fornecedor/cliente, categoria, centro de custo e conta vinculados.', 'lançamento(s) sem o vínculo esperado.');
      rule('installment', `Parcelas (${kind})`, 'Numeração das parcelas preservada.', 'lançamento(s) com parcela diferente.');
    }
    if (entity === 'BANK_ACCOUNT') rule('balance', 'Saldos iniciais das contas bancárias', 'Saldos iniciais conferem.', 'conta(s) com saldo inicial diferente.');
  }
  const analysis = session.analysis as { errors?: unknown[] } | null;
  const alerts: string[] = [];
  if ((analysis?.errors?.length ?? 0) > 0) alerts.push(`${analysis!.errors!.length} arquivo(s) não puderam ser lidos e ficaram fora da migração.`);
  if (counts.rejected > 0) alerts.push(`${counts.rejected} registro(s) rejeitados por erro de validação.`);
  if (counts.failed > 0) alerts.push(`${counts.failed} registro(s) falharam durante a gravação.`);
  if (counts.pendingDivergences > 0) alerts.push(`${counts.pendingDivergences} divergência(s) sem decisão do operador.`);
  const unresolvedRecords = counts.rejected + counts.failed + counts.pendingDivergences + counts.notRun;
  const unreadableFiles = analysis?.errors?.length ?? 0;
  let outcome: Validation['outcome'];
  if (checks.some(check => !check.ok)) outcome = 'FAILED_VALIDATION';
  else if (counts.notRun > 0) outcome = 'INTERRUPTED';
  else if (counts.imported === 0 && counts.read > 0 && counts.duplicates < counts.read) outcome = 'FAILED_VALIDATION';
  else if (unresolvedRecords + unreadableFiles === 0) outcome = 'VALIDATED';
  // Up to 5% of the importable records left unresolved is reported as "with caveats"; beyond that the migration is only partial.
  else outcome = unresolvedRecords / Math.max(counts.imported + unresolvedRecords, 1) <= 0.05 ? 'WITH_CAVEATS' : 'PARTIAL';
  return { outcome, checks, counts, alerts, validatedAt: new Date().toISOString() };
}

// ---- Rollback (section 16): only what this migration created, and only when nothing was built on top of it ----
const MODIFIED_AFTER_MS = 2000;
export async function rollbackSession(session: MigrationSession, actor: Actor) {
  const previous = session.status;
  const claimed = await prisma.migrationSession.updateMany({ where: { id: session.id, tenantId: session.tenantId, status: { in: ['COMPLETED', 'INTERRUPTED', 'CANCELLED'] } }, data: { status: 'ROLLING_BACK' } });
  if (claimed.count !== 1) throw new MigrationError('A reversão só é possível depois que a execução terminou, foi interrompida ou cancelada (e não está em andamento).');
  await logEvent(session, actor.id, 'ROLLBACK_STARTED', `Reversão iniciada por ${actor.label}.`);
  const blocked: { recordId: string; entity: string; reason: string }[] = []; let reverted = 0;
  try {
    // Dependants first: entries and products before the parties and structures they point to.
    const order: EntityKey[] = ['SALE_ITEM', 'SALE', 'EMPLOYEE', 'PAYABLE', 'RECEIVABLE', 'PRODUCT', 'CUSTOMER', 'SUPPLIER', 'BANK_ACCOUNT', 'COST_CENTER', 'FIN_CATEGORY', 'CATEGORY'];
    for (const entity of order) {
      const records = await prisma.migrationRecord.findMany({ where: { sessionId: session.id, entity, status: 'IMPORTED', targetCreated: true, targetId: { not: null } }, orderBy: [{ seq: 'desc' }, { rowIndex: 'desc' }] });
      for (const record of records) {
        const reason = await revertOne(session, record);
        if (reason === null) reverted++; else blocked.push({ recordId: record.id, entity, reason });
      }
    }
  } finally {
    const remaining = await prisma.migrationRecord.count({ where: { sessionId: session.id, status: 'IMPORTED', targetCreated: true } });
    await prisma.migrationSession.update({ where: { id: session.id }, data: remaining === 0 ? { status: 'ROLLED_BACK', rolledBackAt: new Date() } : { status: previous } });
  }
  await logEvent(session, actor.id, blocked.length ? 'ROLLBACK_PARTIAL' : 'ROLLBACK_DONE', `Reversão: ${reverted} registro(s) revertidos, ${blocked.length} bloqueado(s) por segurança.`, { reverted, blocked });
  await prisma.auditLog.create({ data: { tenantId: session.tenantId, actorUserId: actor.id, action: 'MIGRATION_ROLLBACK', entityType: 'MigrationSession', entityId: session.id, metadata: { reverted, blocked: blocked.length } } });
  await refreshSummary(session.id, { financial: true });
  return { reverted, blocked };
}

async function revertOne(session: MigrationSession, record: MigrationRecord): Promise<string | null> {
  const tenantId = session.tenantId; const targetId = record.targetId!;
  const touched = (updatedAt: Date) => updatedAt.getTime() > record.updatedAt.getTime() + MODIFIED_AFTER_MS;
  const markReverted = (tx: Prisma.TransactionClient) => tx.migrationRecord.update({ where: { id: record.id }, data: { status: 'REVERTED' } });
  const remove = async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => { await prisma.$transaction(async tx => { await work(tx); await markReverted(tx); }); return null; };
  const gone = () => remove(async () => undefined);
  switch (record.entity as EntityKey) {
    case 'EMPLOYEE': {
      const employee = await prisma.employee.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!employee) return gone();
      if (touched(employee.updatedAt)) return 'Funcionário alterado depois da migração.';
      const [shifts, user] = await Promise.all([prisma.shift.count({ where: { employeeId: targetId } }), prisma.user.count({ where: { employeeId: targetId } })]);
      if (shifts + user > 0) return 'Funcionário já possui escalas ou usuário vinculado.';
      return remove(tx => tx.employee.delete({ where: { id: targetId } }));
    }
    case 'SALE_ITEM': {
      const item = await prisma.orderItem.findFirst({ where: { id: targetId, order: { tenantId } }, select: { id: true } });
      if (!item) return gone();
      return remove(tx => tx.orderItem.delete({ where: { id: targetId } }));
    }
    case 'SALE': {
      const order = await prisma.order.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true, status: true, total: true } });
      if (!order) return gone();
      const [items, otherPayments, fiscal, entry] = await Promise.all([
        prisma.orderItem.count({ where: { orderId: targetId } }),
        prisma.payment.count({ where: { orderId: targetId, NOT: { reference: `migration:${session.id}` } } }),
        prisma.fiscalDocument.count({ where: { orderId: targetId } }),
        prisma.financialEntry.count({ where: { orderId: targetId } }),
      ]);
      if (items > 0) return 'Venda ainda possui itens (de outra origem ou não revertidos).';
      if (otherPayments > 0 || entry > 0) return 'Venda recebeu pagamentos ou lançamentos depois da migração.';
      if (fiscal > 0) return 'Venda já possui documento fiscal.';
      return remove(async tx => { await tx.payment.deleteMany({ where: { orderId: targetId, reference: `migration:${session.id}` } }); await tx.order.delete({ where: { id: targetId } }); });
    }
    case 'PAYABLE': case 'RECEIVABLE': {
      const entry = await prisma.financialEntry.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true, status: true, amount: true, paidAmount: true, settledAt: true } });
      if (!entry) return gone();
      // Besides the timestamp, the live values are compared with what the migration wrote: a payment or edit made right after the import is never discarded.
      const written = record.normalized as NormalizedValues; const writtenStatus = text(written, 'status') === 'PAID' ? 'PAID' : text(written, 'status') === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
      const changed = entry.status !== writtenStatus || !entry.amount.equals(new Prisma.Decimal(text(written, 'amount') ?? '0')) || !entry.paidAmount.equals(new Prisma.Decimal(text(written, 'paidAmount') ?? '0')) || (entry.settledAt?.toISOString().slice(0, 10) ?? null) !== (writtenStatus === 'PAID' ? text(written, 'settledAt') : null);
      if (changed || touched(entry.updatedAt)) return 'Lançamento alterado ou baixado depois da migração; reverta manualmente para não perder o movimento posterior.';
      return remove(tx => tx.financialEntry.delete({ where: { id: targetId } }));
    }
    case 'PRODUCT': {
      const product = await prisma.product.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!product) return gone();
      if (touched(product.updatedAt)) return 'Produto alterado depois da migração; reverta manualmente para não perder as alterações.';
      const [sold, otherMovements, inCombo] = await Promise.all([
        prisma.orderItem.count({ where: { productId: targetId } }),
        prisma.productStockMovement.count({ where: { productId: targetId, NOT: { reference: `migration:${session.id}` } } }),
        prisma.comboComponent.count({ where: { OR: [{ productId: targetId }, { comboId: targetId }] } }),
      ]);
      if (sold > 0) return 'Produto já utilizado em pedidos.';
      if (otherMovements > 0) return 'Produto com movimentações de estoque posteriores à migração.';
      if (inCombo > 0) return 'Produto já utilizado em combos.';
      return remove(async tx => { await tx.productStockMovement.deleteMany({ where: { productId: targetId, reference: `migration:${session.id}` } }); await tx.product.delete({ where: { id: targetId } }); });
    }
    case 'CUSTOMER': {
      const customer = await prisma.customer.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!customer) return gone();
      if (touched(customer.updatedAt)) return 'Cliente alterado depois da migração.';
      const [orders, entries] = await Promise.all([prisma.order.count({ where: { customerId: targetId } }), prisma.financialEntry.count({ where: { customerId: targetId } })]);
      if (orders + entries > 0) return 'Cliente já possui pedidos ou lançamentos financeiros.';
      return remove(tx => tx.customer.delete({ where: { id: targetId } }));
    }
    case 'SUPPLIER': {
      const supplier = await prisma.supplier.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!supplier) return gone();
      if (touched(supplier.updatedAt)) return 'Fornecedor alterado depois da migração.';
      const [purchases, products, entries] = await Promise.all([prisma.purchaseOrder.count({ where: { supplierId: targetId } }), prisma.product.count({ where: { supplierId: targetId } }), prisma.financialEntry.count({ where: { supplierId: targetId } })]);
      if (purchases > 0) return 'Fornecedor já possui pedidos de compra.';
      if (products + entries > 0) return 'Fornecedor ainda vinculado a produtos ou lançamentos financeiros.';
      return remove(tx => tx.supplier.delete({ where: { id: targetId } }));
    }
    case 'BANK_ACCOUNT': {
      const account = await prisma.bankAccount.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!account) return gone();
      if (touched(account.updatedAt)) return 'Conta bancária alterada depois da migração.';
      if (await prisma.financialEntry.count({ where: { bankAccountId: targetId } }) > 0) return 'Conta bancária ainda vinculada a lançamentos financeiros.';
      return remove(tx => tx.bankAccount.delete({ where: { id: targetId } }));
    }
    case 'COST_CENTER': {
      const center = await prisma.costCenter.findFirst({ where: { id: targetId, tenantId }, select: { updatedAt: true } });
      if (!center) return gone();
      if (touched(center.updatedAt)) return 'Centro de custo alterado depois da migração.';
      if (await prisma.financialEntry.count({ where: { costCenterId: targetId } }) > 0) return 'Centro de custo ainda vinculado a lançamentos financeiros.';
      return remove(tx => tx.costCenter.delete({ where: { id: targetId } }));
    }
    case 'FIN_CATEGORY': {
      const category = await prisma.financialCategory.findFirst({ where: { id: targetId, tenantId }, select: { name: true, type: true } });
      if (!category) return gone();
      const [entries, children] = await Promise.all([prisma.financialEntry.count({ where: { tenantId, type: category.type, category: category.name } }), prisma.financialCategory.count({ where: { parentId: targetId } })]);
      if (entries > 0) return 'Categoria financeira ainda utilizada em lançamentos.';
      if (children > 0) return 'Categoria financeira ainda possui subcategorias.';
      return remove(tx => tx.financialCategory.delete({ where: { id: targetId } }));
    }
    case 'CATEGORY': {
      if (!await prisma.productCategory.findFirst({ where: { id: targetId, tenantId }, select: { id: true } })) return gone();
      if (await prisma.product.count({ where: { categoryId: targetId } }) > 0) return 'Categoria ainda possui produtos.';
      if (await prisma.productCategory.count({ where: { parentId: targetId } }) > 0) return 'Categoria ainda possui subcategorias.';
      return remove(tx => tx.productCategory.delete({ where: { id: targetId } }));
    }
  }
}
