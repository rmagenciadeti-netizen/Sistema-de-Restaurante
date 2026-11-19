import { FiscalStatus, PaymentStatus, PrintJobKind, PrintJobStatus, PrinterKind, Prisma, type Printer } from '@prisma/client';
import { prisma } from './prisma';
import { loadSettings } from './settings';
import { centerLines, paperColumns } from './ticket';
import { receiptLines } from './tef/service';

// Receipts (TEF slip, sale receipt, fiscal document) share one path: pick the receipt printer, render for its paper width, queue the original once (dedup key) and make every reprint an audited, marked job.
export class ReceiptError extends Error { constructor(message: string, readonly status = 409, readonly code = 'RECEIPT_ERROR') { super(message); } }

type Scope = { tenantId: string; unitId: string | null };
const money = (value: Prisma.Decimal | number | string) => Number(value).toFixed(2).replace('.', ',');
const METHOD: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Crédito', DEBIT_CARD: 'Débito', VOUCHER: 'Voucher', OTHER: 'Outros' };

// Receipt printer of the unit (primary first), then a shared one. `printerId` pins a specific terminal printer.
export async function pickReceiptPrinter(tx: Prisma.TransactionClient, scope: Scope, printerId?: string | null): Promise<Printer | null> {
  const where = { tenantId: scope.tenantId, active: true, OR: [{ unitId: scope.unitId }, { unitId: null }] };
  if (printerId) return tx.printer.findFirst({ where: { ...where, id: printerId } });
  const candidates = await tx.printer.findMany({ where: { ...where, kind: PrinterKind.RECEIPT } });
  const rank = (printer: Printer) => (printer.unitId === scope.unitId ? 0 : 2) + (printer.isPrimary ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export type EnqueueReceipt = {
  scope: Scope; orderId: string | null; userId: string; key: string; copies: number; render: (columns: number, reprint: boolean) => string; reason?: string | null; printerId?: string | null; label: string;
};

// First request queues the original (idempotent: repeating it returns the same job). A request with `reason` is an audited reprint.
export async function enqueueReceipt(input: EnqueueReceipt) {
  const reprint = Boolean(input.reason);
  if (reprint && input.reason!.trim().length < 5) throw new ReceiptError('Informe o motivo da reimpressão (mín. 5 caracteres).', 400, 'REPRINT_REASON');
  return prisma.$transaction(async tx => {
    const original = await tx.printJob.findFirst({ where: { tenantId: input.scope.tenantId, dedupKey: `${input.key}:1` }, select: { id: true } });
    if (reprint && !original) throw new ReceiptError('Este comprovante ainda não foi impresso; imprima o original antes de reimprimir.', 409, 'NOTHING_TO_REPRINT');
    const printer = await pickReceiptPrinter(tx, input.scope, input.printerId);
    const columns = printer ? paperColumns(printer.paperWidthMm) : 48;
    const content = input.render(columns, reprint);
    const jobs = [];
    let deduplicated = false;
    for (let copy = 1; copy <= input.copies; copy++) {
      const data = { tenantId: input.scope.tenantId, unitId: input.scope.unitId, orderId: input.orderId, printerId: printer?.id ?? null, kind: PrintJobKind.RECEIPT, content, status: printer ? PrintJobStatus.PENDING : PrintJobStatus.FAILED, error: printer ? null : 'NO_ACTIVE_RECEIPT_PRINTER' };
      if (reprint) { jobs.push(await tx.printJob.create({ data })); continue; }
      const existing = await tx.printJob.findFirst({ where: { tenantId: input.scope.tenantId, dedupKey: `${input.key}:${copy}` } });
      if (existing) { deduplicated = true; jobs.push(existing); continue; }
      jobs.push(await tx.printJob.create({ data: { ...data, dedupKey: `${input.key}:${copy}` } }));
    }
    if (reprint) await tx.auditLog.create({ data: { tenantId: input.scope.tenantId, actorUserId: input.userId, action: 'RECEIPT_REPRINTED', entityType: 'PrintJob', entityId: jobs[0]!.id, metadata: { label: input.label, key: input.key, reason: input.reason!.trim(), copies: input.copies, orderId: input.orderId } } });
    else if (!deduplicated) await tx.auditLog.create({ data: { tenantId: input.scope.tenantId, actorUserId: input.userId, action: 'RECEIPT_PRINTED', entityType: 'PrintJob', entityId: jobs[0]!.id, metadata: { label: input.label, key: input.key, copies: input.copies, orderId: input.orderId } } });
    return { jobs, deduplicated, reprint, printerFound: Boolean(printer) };
  });
}

export async function companyHeader(scope: Scope) {
  const settings = await loadSettings(prisma, scope.tenantId);
  return { company: settings.company.tradeName || settings.company.legalName || 'RM Restaurant', cnpj: settings.company.document || null, footer: settings.printing.footer, receiptCopies: settings.printing.receiptCopies, tefCopies: settings.printing.tefCopies };
}

const wrapFooter = (footer: string, columns: number) => footer ? ['', ...footer.match(new RegExp(`.{1,${columns}}(\\s|$)`, 'g'))!.map(line => line.trim())] : [];

export async function loadSaleOrder(scope: Scope, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: scope.tenantId, ...(scope.unitId ? { unitId: scope.unitId } : {}) }, include: { items: { where: { status: { not: 'CANCELLED' } }, include: { product: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }, payments: { where: { status: PaymentStatus.CONFIRMED } } } });
  if (!order) throw new ReceiptError('Pedido não encontrado.', 404, 'ORDER_NOT_FOUND');
  return order;
}

export function saleReceiptText(order: Awaited<ReturnType<typeof loadSaleOrder>>, columns: number, reprint: boolean, header: Awaited<ReturnType<typeof companyHeader>>) {
  const rule = '-'.repeat(columns);
  const center = (text: string) => centerLines(text, columns);
  const row = (label: string, value: string) => { const gap = columns - label.length - value.length; return gap >= 1 ? label + ' '.repeat(gap) + value : `${label.slice(0, Math.max(1, columns - value.length - 1))} ${value}`; };
  const lines = [...center(header.company.toUpperCase()), ...(header.cnpj ? center(`CNPJ ${header.cnpj}`) : []), rule, ...center('RECIBO - NÃO É DOCUMENTO FISCAL'), ...(reprint ? center('*** REIMPRESSÃO ***') : []), rule, `Pedido: ${order.code}`, ...(order.tableLabel ? [`Mesa: ${order.tableLabel}`] : []), rule];
  for (const item of order.items) lines.push(row(`${Number(item.quantity)}x ${item.product.name}`, money(item.total)));
  lines.push(rule, row('Subtotal', money(order.subtotal)));
  if (order.discount.gt(0)) lines.push(row('Desconto', `-${money(order.discount)}`));
  if (order.serviceFee.gt(0)) lines.push(row('Serviço', money(order.serviceFee)));
  if (order.deliveryFee.gt(0)) lines.push(row('Entrega', money(order.deliveryFee)));
  lines.push(row('TOTAL', money(order.total)), rule);
  for (const payment of order.payments) lines.push(row(METHOD[payment.method] ?? payment.method, money(payment.amount)));
  lines.push(...wrapFooter(header.footer, columns), rule);
  return lines.join('\n');
}

export async function loadFiscalDocument(scope: Scope, documentId: string) {
  const document = await prisma.fiscalDocument.findFirst({ where: { id: documentId, tenantId: scope.tenantId, ...(scope.unitId ? { unitId: scope.unitId } : {}) }, include: { order: { select: { id: true, code: true, total: true } } } });
  if (!document) throw new ReceiptError('Documento fiscal não encontrado.', 404, 'FISCAL_NOT_FOUND');
  if (document.status !== FiscalStatus.AUTHORIZED) throw new ReceiptError('Somente documento fiscal autorizado pode ser impresso.', 409, 'FISCAL_NOT_AUTHORIZED');
  return document;
}

export function fiscalDocumentText(document: Awaited<ReturnType<typeof loadFiscalDocument>>, columns: number, reprint: boolean, header: Awaited<ReturnType<typeof companyHeader>>) {
  const rule = '-'.repeat(columns);
  const center = (text: string) => centerLines(text, columns);
  const wrap = (text: string) => text.match(new RegExp(`.{1,${columns}}`, 'g')) ?? [];
  const homologation = document.environment === 'HOMOLOGATION';
  const lines = [...center(header.company.toUpperCase()), ...(header.cnpj ? center(`CNPJ ${header.cnpj}`) : []), rule, ...center(document.kind === 'NFCE' ? 'DANFE NFC-e (via do consumidor)' : `Documento fiscal ${document.kind}`), ...(homologation ? center('SEM VALOR FISCAL - HOMOLOGAÇÃO') : []), ...(reprint ? center('*** REIMPRESSÃO ***') : []), rule,
    `Pedido: ${document.order.code}`, `Série ${document.series ?? '-'}  Nº ${document.number ?? '-'}`, `Total: R$ ${money(document.order.total)}`, ...(document.protocol ? [`Protocolo: ${document.protocol}`] : []),
    ...(document.accessKey ? ['Chave de acesso:', ...wrap(document.accessKey.replace(/(\d{4})(?=\d)/g, '$1 '))] : []), ...(document.documentUrl ? ['Consulta:', ...wrap(document.documentUrl)] : []), ...wrapFooter(header.footer, columns), rule];
  return lines.join('\n');
}

export { receiptLines };

// Automatic TEF slip after an approval, when the terminal configuration asks for it. It never fails the payment and the dedup key keeps it to one original.
export async function autoPrintTefReceipt(transaction: import('@prisma/client').TefTransaction, userId: string | null) {
  try {
    if (transaction.status !== 'APPROVED') return;
    const config = await prisma.tefProviderConfig.findUnique({ where: { tenantId_provider: { tenantId: transaction.tenantId, provider: transaction.provider } }, select: { printing: true } });
    if (!(config?.printing as { autoPrint?: boolean } | null)?.autoPrint) return;
    const scope = { tenantId: transaction.tenantId, unitId: transaction.unitId };
    const header = await companyHeader(scope);
    const copies = header.tefCopies === 'BOTH' ? ['CUSTOMER', 'MERCHANT'] as const : ['CUSTOMER'] as const;
    for (const copy of copies) await enqueueReceipt({ scope, orderId: transaction.orderId, userId: userId ?? transaction.operatorUserId ?? '', key: `tef:${transaction.id}:${copy}`, copies: 1, label: `TEF ${copy} (automático)`, render: (columns, reprint) => receiptLines(transaction, copy, header, columns, reprint).join('\n') });
  } catch { /* printing problems are visible in the print queue and never undo a payment */ }
}
