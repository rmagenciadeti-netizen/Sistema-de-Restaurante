import { Prisma } from '@prisma/client';
import { cleanText, detectDateOrder, normalizeBarcode, normalizeDocument, normalizeEmail, normalizePhoneValue, normalizeState, normalizeUnit, normalizeZip, parseBoolean, parseDateValue, parseEntryStatus, parseFinType, parseInstallment, parseMoney, parsePercent, parseQuantity, type DateOrder } from './normalize';
import { ENTITIES, isFinancialEntry, outputKey, type EntityKey } from './targets';

export type Correction = { field: string; column?: string; original: string | null; corrected: string | boolean | null; rule: string; reason: string; actor?: string };
export type Issue = { field: string; severity: 'error' | 'review' | 'info'; code: string; message: string; suggestion?: string };
export type NormalizedValues = Record<string, string | boolean | null>;
export type EvalContext = { dateOrders?: Record<string, DateOrder>; today?: Date };
export { detectDateOrder };

const blank = (value: string | null | undefined) => value === null || value === undefined || value.trim() === '';
const D = (value: string | boolean | null | undefined) => new Prisma.Decimal(value === null || value === undefined || value === false || value === true ? 0 : value);

// ---- Field level normalization (also used to re-validate manual corrections) ----
export function evaluateFields(entity: EntityKey, raw: Record<string, string | null>, columns: Record<string, string> = {}, ctx: EvalContext = {}): { normalized: NormalizedValues; corrections: Correction[]; issues: Issue[] } {
  const normalized: NormalizedValues = {}; const corrections: Correction[] = []; const issues: Issue[] = [];
  const input = { ...raw };
  if (entity === 'CUSTOMER' && blank(input.phone) && !blank(input.whatsapp)) {
    corrections.push({ field: 'phone', column: columns.whatsapp, original: null, corrected: input.whatsapp!.trim(), rule: 'whatsapp_as_phone', reason: 'Telefone ausente na origem; o número de WhatsApp informado foi usado como telefone de contato.' });
    input.phone = input.whatsapp;
  }
  for (const field of ENTITIES[entity].fields) {
    const key = outputKey(field); const original = input[field.key] ?? null;
    const note = (rule?: string, reason?: string, corrected?: string | boolean | null) => { if (rule) corrections.push({ field: key, column: columns[field.key], original, corrected: corrected ?? null, rule, reason: reason ?? '' }); };
    const fail = (code: string, message: string, suggestion?: string) => { issues.push({ field: key, severity: field.required ? 'error' : 'review', code, message, suggestion }); normalized[key] = null; };
    if (blank(original)) {
      normalized[key] = normalized[key] ?? null;
      if (field.required) issues.push({ field: key, severity: 'error', code: 'required_missing', message: `${field.label} é obrigatório no RM Restaurant e está vazio na origem.`, suggestion: 'Corrija manualmente ou ignore o registro.' });
      else if (field.kind === 'ref' && (field.key === 'categoryRef' && entity === 'PRODUCT')) issues.push({ field: key, severity: 'info', code: 'no_category', message: 'Produto sem categoria na origem; será importado sem categoria.' });
      continue;
    }
    const value = original!;
    switch (field.kind) {
      case 'text': case 'code': case 'ref': {
        const cleaned = cleanText(value); const text = cleaned.ok ? cleaned.value : null;
        if (text === null) { fail('required_missing', `${field.label} vazio.`); break; }
        if ((field.key === 'name' || field.key === 'description') && field.required && text.length < 2) { fail('too_short', `${field.label} precisa ter ao menos 2 caracteres.`); break; }
        if (field.max && text.length > field.max) { fail('too_long', `${field.label} excede ${field.max} caracteres (${text.length}).`, 'Reduza manualmente; truncar descartaria informação.'); break; }
        normalized[key] = text; if (cleaned.ok) note(cleaned.rule, cleaned.reason, text); break;
      }
      case 'money': case 'quantity': case 'balance': case 'percent': {
        const parsed = field.kind === 'money' || field.kind === 'balance' ? parseMoney(value) : field.kind === 'quantity' ? parseQuantity(value) : parsePercent(value);
        if (!parsed.ok) { fail(parsed.code, parsed.message, parsed.ambiguous ? 'Informe o valor correto manualmente.' : undefined); break; }
        if (parsed.value.startsWith('-') && field.kind !== 'balance') { fail('negative', `${field.label} negativo (${value.trim()}).`, 'Valores negativos não são aceitos; corrija manualmente ou ignore o registro.'); break; }
        if (Math.abs(Number(parsed.value)) > 999_999_999) { fail('out_of_range', `${field.label} fora do limite suportado.`); break; }
        normalized[key] = parsed.value; note(parsed.rule, parsed.reason, parsed.value); break;
      }
      case 'document': { const result = normalizeDocument(value); if (!result.ok) { fail(result.code, result.message, 'Confirme o documento com o restaurante; o valor original foi preservado.'); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'phone': { const result = normalizePhoneValue(value); if (!result.ok) { fail(result.code, result.message); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'email': { const result = normalizeEmail(value); if (!result.ok) { fail(result.code, result.message); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'unit': { const result = normalizeUnit(value); if (!result.ok) { fail(result.code, result.message, 'Escolha uma unidade válida manualmente.'); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'barcode': { const result = normalizeBarcode(value); if (!result.ok) { fail(result.code, result.message); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'zip': { const result = normalizeZip(value); if (!result.ok) { fail(result.code, result.message); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'state': { const result = normalizeState(value); if (!result.ok) { fail(result.code, result.message); break; } normalized[key] = result.value; note(result.rule, result.reason, result.value); break; }
      case 'boolean': { const flag = parseBoolean(value); if (flag === null) { fail('unknown_boolean', `Valor "${value.trim()}" não indica ativo/inativo.`); break; } normalized[key] = flag; note('boolean_value', `"${value.trim()}" interpretado como ${flag ? 'ativo' : 'inativo'}.`, flag); break; }
      case 'ncm': { const digits = value.replace(/\D/g, ''); if (!/^\d{8}$/.test(digits)) { fail('invalid_ncm', `NCM "${value.trim()}" deve ter 8 dígitos.`); break; } normalized[key] = digits; if (digits !== value.trim()) note('ncm_digits', 'Pontuação do NCM removida.', digits); break; }
      case 'int': { if (!/^\d{1,5}$/.test(value.trim())) { fail('invalid_integer', `"${value.trim()}" não é um número inteiro válido.`); break; } normalized[key] = value.trim(); break; }
      case 'date': {
        const parsed = parseDateValue(value, ctx.dateOrders?.[field.key] ?? 'dmy');
        if (!parsed) { fail('invalid_date', `Data "${value.trim()}" não reconhecida (use dd/mm/aaaa ou aaaa-mm-dd).`); break; }
        const year = Number(parsed.iso.slice(0, 4));
        if (year < 1990 || year > 2100) { fail('date_out_of_range', `Data ${parsed.iso} fora do intervalo plausível (1990–2100).`, 'Confira o ano na origem.'); break; }
        normalized[key] = parsed.iso; note(parsed.iso !== value.trim() ? 'date_format' : undefined, `Data convertida para o formato ISO (${parsed.iso}).`, parsed.iso); break;
      }
      case 'finType': { const type = parseFinType(value); if (!type) { fail('unknown_type', `Tipo "${value.trim()}" não indica receita ou despesa.`, 'Informe manualmente: INCOME (receita) ou EXPENSE (despesa).'); break; } normalized[key] = type; note('finance_type', `"${value.trim()}" interpretado como ${type === 'INCOME' ? 'receita' : 'despesa'}.`, type); break; }
      case 'entryStatus': {
        const status = parseEntryStatus(value);
        if (!status) { issues.push({ field: key, severity: 'review', code: 'unknown_status', message: `Situação "${value.trim()}" não reconhecida (aberto, pago, parcial, cancelado...).`, suggestion: 'Corrija manualmente a situação; o valor original foi preservado.' }); normalized[key] = null; break; }
        normalized[key] = status.status; note('status_mapped', status.overdueWord ? `"${value.trim()}" corresponde a conta em aberto vencida; o RM calcula o atraso pela data de vencimento.` : `Situação "${value.trim()}" interpretada como ${status.status}.`, status.status); break;
      }
      case 'installment': {
        const parsed = parseInstallment(value);
        if (!parsed || parsed.number < 1) { fail('invalid_installment', `Parcela "${value.trim()}" não reconhecida (use 2 ou 2/5).`); break; }
        normalized[key] = String(parsed.number);
        if (parsed.count !== null) {
          if (blank(input.installmentCount)) { normalized.installmentCount = String(parsed.count); note('installment_split', `"${value.trim()}" separado em parcela ${parsed.number} de ${parsed.count}.`, String(parsed.number)); }
          else if (Number(input.installmentCount) !== parsed.count) issues.push({ field: key, severity: 'review', code: 'installment_mismatch', message: `Parcela "${value.trim()}" contradiz a quantidade de parcelas informada (${input.installmentCount}).` });
        }
        break;
      }
    }
  }
  if (isFinancialEntry(entity)) financeRules(entity, normalized, input, corrections, issues, ctx.today ?? new Date());
  if (entity === 'PRODUCT') marginCheck(normalized, issues);
  return { normalized, corrections, issues };
}

function marginCheck(values: NormalizedValues, issues: Issue[]) {
  if (typeof values.margin !== 'string' || typeof values.price !== 'string' || typeof values.cost !== 'string') return;
  const price = D(values.price); const cost = D(values.cost);
  if (price.lte(0) || cost.lte(0)) return;
  const margin = Number(values.margin);
  const asMargin = price.sub(cost).div(price).mul(100).toNumber(); const asMarkup = price.sub(cost).div(cost).mul(100).toNumber();
  if (Math.abs(margin - asMargin) > 1 && Math.abs(margin - asMarkup) > 1) issues.push({ field: 'margin', severity: 'info', code: 'margin_mismatch', message: `Margem informada (${margin}%) não confere com preço e custo (${asMargin.toFixed(1)}% de margem / ${asMarkup.toFixed(1)}% de markup). A margem não é gravada: o RM a calcula.` });
}

// Deterministic financial rules: payments are never invented, and contradictory sources are held for a human decision.
function financeRules(entity: 'PAYABLE' | 'RECEIVABLE', values: NormalizedValues, raw: Record<string, string | null>, corrections: Correction[], issues: Issue[], today: Date) {
  const add = (field: string, severity: Issue['severity'], code: string, message: string, suggestion?: string) => issues.push({ field, severity, code, message, suggestion });
  const paidWord = entity === 'PAYABLE' ? 'pago' : 'recebido';
  const number = values.installmentNumber !== null && values.installmentNumber !== undefined ? Number(values.installmentNumber) : null;
  const count = values.installmentCount !== null && values.installmentCount !== undefined ? Number(values.installmentCount) : null;
  if (count !== null && (count < 1 || count > 999)) add('installmentCount', 'review', 'installment_range', `Quantidade de parcelas ${count} fora do intervalo 1–999.`);
  if (number !== null && count !== null && number > count) add('installmentNumber', 'review', 'installment_order', `Parcela ${number} maior que o total de parcelas (${count}).`);
  if (typeof values.amount !== 'string') return;
  const amount = D(values.amount);
  if (amount.lte(0)) { add('amount', 'error', 'zero_amount', 'Valor original deve ser maior que zero.', 'Corrija manualmente ou ignore o registro.'); return; }
  const interest = D(values.interestAmount); const discount = D(values.discountAmount); const due = amount.add(interest).sub(discount);
  if (due.lt(0)) add('discountAmount', 'review', 'discount_exceeds', 'O desconto supera o valor original somado aos juros.');
  const paid = typeof values.paidAmount === 'string' ? D(values.paidAmount) : null;
  const sourceStatus = (values.status as string | null) ?? null;
  const settledAt = typeof values.settledAt === 'string' ? values.settledAt : null;
  const todayIso = today.toISOString().slice(0, 10);
  if (typeof values.issuedAt === 'string' && typeof values.dueAt === 'string' && values.dueAt < values.issuedAt) add('dueAt', 'review', 'due_before_issue', 'Vencimento anterior à data de emissão.');
  if (settledAt && settledAt > todayIso) add('settledAt', 'review', 'future_settlement', `Data de ${paidWord === 'pago' ? 'pagamento' : 'recebimento'} no futuro (${settledAt}).`, 'Um pagamento futuro não pode ser registrado como realizado.');
  if (settledAt && typeof values.issuedAt === 'string' && settledAt < values.issuedAt) add('settledAt', 'review', 'settled_before_issue', 'Data de baixa anterior à emissão.');

  let status: 'OPEN' | 'PAID' | 'CANCELLED';
  let finalPaid: Prisma.Decimal = paid ?? new Prisma.Decimal(0);
  let finalSettled: string | null = null;
  const rawStatusPresent = !blank(raw.status);
  if (sourceStatus === null) {
    // No (recognised) status: infer only from facts of the same row; an unrecognised status was already flagged.
    const hasPayment = paid !== null && paid.gt(0);
    if (rawStatusPresent) status = 'OPEN';
    else if (hasPayment && paid!.gte(due) && settledAt) { status = 'PAID'; finalSettled = settledAt; corrections.push({ field: 'status', original: null, corrected: 'PAID', rule: 'status_inferred', reason: `Sem situação na origem; valor ${paidWord} cobre o total e há data de baixa.` }); }
    else if (hasPayment && paid!.lt(due)) { status = 'OPEN'; corrections.push({ field: 'status', original: null, corrected: 'OPEN', rule: 'status_inferred', reason: `Sem situação na origem; valor ${paidWord} parcial: lançamento em aberto com baixa parcial.` }); }
    else {
      status = 'OPEN';
      if (hasPayment || settledAt) add('status', 'review', 'status_unclear', 'Há data ou valor de baixa, mas a situação do lançamento não foi informada nem pôde ser deduzida com segurança.', 'Defina a situação manualmente.');
      else corrections.push({ field: 'status', original: null, corrected: 'OPEN', rule: 'status_inferred', reason: 'Sem situação, valor pago ou data de baixa na origem: lançamento em aberto.' });
    }
  } else if (sourceStatus === 'CANCELLED') {
    status = 'CANCELLED';
    if (paid && paid.gt(0)) add('paidAmount', 'review', 'cancelled_with_payment', 'Lançamento cancelado, mas com valor baixado informado.', 'Confirme se o cancelamento é válido; o valor informado será preservado.');
  } else if (sourceStatus === 'PAID') {
    status = 'PAID';
    if (!settledAt) add('settledAt', 'error', 'paid_without_date', `Lançamento ${paidWord} sem data de ${paidWord === 'pago' ? 'pagamento' : 'recebimento'}: o RM não inventa datas.`, `Informe a data manualmente ou ajuste a situação para Em aberto.`);
    if (paid === null) { finalPaid = due; add('paidAmount', 'review', 'paid_without_amount', `Situação ${paidWord} sem valor ${paidWord}: o total (${due.toFixed(2)}) foi assumido.`, 'Confirme o valor efetivamente baixado.'); corrections.push({ field: 'paidAmount', original: null, corrected: due.toFixed(2), rule: 'paid_assumed_full', reason: `Situação indica quitação sem valor baixado; assumido o total (valor + juros − desconto) — requer aprovação.` }); }
    else if (paid.lt(due)) add('paidAmount', 'review', 'paid_less_than_due', `Valor ${paidWord} (${paid.toFixed(2)}) menor que o devido (${due.toFixed(2)}) com situação quitada.`, 'Informe o desconto/abatimento ou classifique como parcialmente pago.');
    else if (paid.gt(due)) add('paidAmount', 'review', 'overpaid', `Valor ${paidWord} (${paid.toFixed(2)}) maior que o devido (${due.toFixed(2)}).`, 'Informe juros/multa que expliquem a diferença.');
    finalSettled = settledAt;
  } else if (sourceStatus === 'PARTIAL') {
    status = 'OPEN';
    if (paid === null || paid.lte(0) || paid.gte(due)) add('paidAmount', 'review', 'partial_inconsistent', `Situação parcial exige valor ${paidWord} maior que zero e menor que o devido (${due.toFixed(2)}).`, 'Corrija o valor ou a situação.');
  } else {
    status = 'OPEN';
    if (paid && paid.gt(0) && paid.gte(due)) add('status', 'review', 'open_but_paid', `Situação em aberto, mas o valor ${paidWord} (${paid.toFixed(2)}) cobre o total devido.`, 'Defina se o lançamento está quitado.');
    if (settledAt && !(paid && paid.gt(0))) add('settledAt', 'review', 'open_with_date', 'Lançamento em aberto com data de baixa informada.', 'Defina a situação correta.');
  }
  if (status !== 'PAID' && paid && paid.gt(0) && paid.lt(due) && settledAt) {
    // A partial payment keeps the last payment date as a note instead of marking the entry as settled.
    const noted = `Último pagamento parcial em ${settledAt.split('-').reverse().join('/')}.`;
    values.notes = typeof values.notes === 'string' ? `${values.notes} ${noted}` : noted;
    corrections.push({ field: 'notes', original: null, corrected: noted, rule: 'partial_date_to_notes', reason: 'Data do pagamento parcial preservada nas observações; o lançamento segue em aberto.' });
  }
  if (status === 'OPEN' && typeof values.dueAt !== 'string') add('dueAt', 'review', 'missing_due_date', 'Lançamento em aberto sem data de vencimento.', 'Informe o vencimento manualmente ou aprove sem data.');
  values.status = status; values.paidAmount = finalPaid.toFixed(2); values.settledAt = status === 'PAID' ? finalSettled : null;
}

