// Deterministic, verifiable value normalizers for RM Smart Migration. Each one reports the rule applied so the audit can show original -> corrected.

export type Normalized<T> =
  | { ok: true; value: T; rule?: string; reason?: string }
  | { ok: false; code: string; message: string; ambiguous?: boolean };

const stripControl = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export function cleanText(raw: string | null | undefined): Normalized<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const original = String(raw);
  let value = stripControl(original).normalize('NFC').replace(/[\u00a0\u2007\u202f]/g, ' ');
  let rule: string | undefined; let reason: string | undefined;
  // UTF-8 text decoded as Latin-1 ("CafÃ©"): re-decoding is only accepted when it strictly removes the mojibake pairs.
  if (/[ÃÂ][\u0080-\u00bf]/.test(value)) {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    if (!repaired.includes('\ufffd') && repaired.length < value.length) { value = repaired; rule = 'charset_repair'; reason = 'Texto UTF-8 lido como Latin-1 foi decodificado novamente.'; }
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === original) return { ok: true, value: collapsed === '' ? null : collapsed };
  return { ok: true, value: collapsed === '' ? null : collapsed, rule: rule ?? 'trim_spaces', reason: reason ?? 'Espaços repetidos ou nas extremidades removidos.' };
}

// Brazilian (1.234,56) and international (1,234.56) money/number formats. A lone separator followed by exactly three digits is genuinely ambiguous.
export function parseDecimal(raw: string, maxDecimals: number): Normalized<string> {
  const original = raw.trim();
  let text = original.replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (text === '') return { ok: false, code: 'empty', message: 'Valor vazio.' };
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  if (!/^\d[\d.,]*$/.test(text)) return { ok: false, code: 'not_numeric', message: `"${original}" não é um número reconhecível.` };
  const malformed = { ok: false as const, code: 'malformed_number', message: `"${original}" mistura separadores de forma inconsistente.` };
  const lastDot = text.lastIndexOf('.'); const lastComma = text.lastIndexOf(',');
  let integer: string; let fraction = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSeparator = lastDot > lastComma ? '.' : ','; const thousands = decimalSeparator === '.' ? ',' : '.';
    const intPart = text.slice(0, Math.max(lastDot, lastComma)); fraction = text.slice(Math.max(lastDot, lastComma) + 1);
    const groups = intPart.split(thousands);
    if (intPart.includes(decimalSeparator) || groups.slice(1).some(group => group.length !== 3) || groups[0].length > 3) return malformed;
    integer = groups.join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? '.' : ',';
    const parts = text.split(separator);
    if (parts.length > 2) {
      if (parts.slice(1).some(group => group.length !== 3) || parts[0].length > 3) return malformed;
      integer = parts.join('');
    } else if (parts[1].length === 3 && /^[1-9]\d{0,2}$/.test(parts[0])) {
      return { ok: false, code: 'ambiguous_separator', ambiguous: true, message: `"${original}" pode ser ${parts[0]}${parts[1]} (milhar) ou ${parts[0]}.${parts[1]} (decimal); confirme o valor.` };
    } else { integer = parts[0]; fraction = parts[1]; }
  } else integer = text;
  fraction = fraction.replace(/0+$/, '');
  if (fraction.length > maxDecimals) return { ok: false, code: 'too_many_decimals', message: `"${original}" tem mais de ${maxDecimals} casas decimais; arredondar alteraria o valor.` };
  const value = `${negative ? '-' : ''}${integer.replace(/^0+(?=\d)/, '')}${fraction ? `.${fraction}` : ''}`;
  const changed = value !== original;
  return { ok: true, value, rule: changed ? 'decimal_format' : undefined, reason: changed ? 'Separadores de milhar/decimal e símbolo monetário padronizados.' : undefined };
}

export const parseMoney = (raw: string) => parseDecimal(raw, 2);
export const parseQuantity = (raw: string) => parseDecimal(raw, 3);

const allEqual = (digits: string) => /^(\d)\1+$/.test(digits);
export function validCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || allEqual(digits)) return false;
  for (const length of [9, 10]) {
    const sum = [...digits.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    if (((sum * 10) % 11) % 10 !== Number(digits[length])) return false;
  }
  return true;
}
export function validCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || allEqual(digits)) return false;
  for (const length of [12, 13]) {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = [...digits.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    if ((sum % 11 < 2 ? 0 : 11 - (sum % 11)) !== Number(digits[length])) return false;
  }
  return true;
}
export function validGtin(digits: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
  const sum = [...digits.slice(0, -1)].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export function normalizeDocument(raw: string): Normalized<string> {
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return { ok: false, code: 'empty', message: 'Documento vazio.' };
  // Spreadsheets drop leading zeros from CPFs; padding is only accepted when the check digits then validate.
  const candidates = digits.length < 11 ? [digits.padStart(11, '0')] : digits.length > 11 && digits.length < 14 ? [digits.padStart(14, '0')] : [digits];
  const value = candidates.find(candidate => validCpf(candidate) || validCnpj(candidate));
  if (!value) return { ok: false, code: 'invalid_document', message: `Documento "${raw.trim()}" não é um CPF/CNPJ válido (dígitos verificadores).` };
  if (value === raw.trim()) return { ok: true, value };
  return { ok: true, value, rule: 'document_digits', reason: value.length !== digits.length ? 'Zeros à esquerda restaurados e pontuação removida; dígitos verificadores conferem.' : 'Pontuação do documento removida.' };
}

// Existing customers may have been stored with the country code (WhatsApp) or without it (POS); both forms identify the same phone.
export const phoneKey = (phone: string) => phone.startsWith('55') && phone.length >= 12 ? phone.slice(2) : phone;
export const phoneVariants = (phone: string) => [phone, `55${phone}`];

export function normalizePhoneValue(raw: string): Normalized<string> {
  let digits = raw.replace(/\D/g, '');
  if (digits === '') return { ok: false, code: 'empty', message: 'Telefone vazio.' };
  if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  if (digits.length < 8 || digits.length > 11) return { ok: false, code: 'invalid_phone', message: `Telefone "${raw.trim()}" tem ${digits.length} dígitos.` };
  return digits === raw.trim() ? { ok: true, value: digits } : { ok: true, value: digits, rule: 'phone_digits', reason: 'Telefone reduzido a dígitos (DDI/zeros iniciais removidos).' };
}

export function normalizeEmail(raw: string): Normalized<string> {
  const value = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) return { ok: false, code: 'invalid_email', message: `E-mail "${raw.trim()}" inválido.` };
  return value === raw ? { ok: true, value } : { ok: true, value, rule: 'email_lowercase', reason: 'E-mail padronizado em minúsculas e sem espaços.' };
}

const TRUE_WORDS = new Set(['1', 's', 'sim', 'y', 'yes', 'true', 'verdadeiro', 'v', 't', 'ativo', 'ativa', 'a', 'active', 'habilitado', 'on']);
const FALSE_WORDS = new Set(['0', 'n', 'nao', 'não', 'no', 'false', 'falso', 'f', 'inativo', 'inativa', 'i', 'inactive', 'desabilitado', 'off', 'bloqueado', 'excluido', 'excluído']);
export function parseBoolean(raw: string): boolean | null {
  const word = raw.trim().toLowerCase();
  return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
}

const UNITS: Record<string, string> = {
  un: 'UN', und: 'UN', unid: 'UN', unidade: 'UN', pc: 'UN', pç: 'UN', peca: 'UN', peça: 'UN', unit: 'UN', pcs: 'UN',
  kg: 'KG', quilo: 'KG', kilo: 'KG', quilograma: 'KG', g: 'G', gr: 'G', grama: 'G', l: 'L', lt: 'L', lts: 'L', litro: 'L', ml: 'ML', mililitro: 'ML',
  cx: 'CX', caixa: 'CX', pct: 'PCT', pacote: 'PCT', pac: 'PCT', porcao: 'PORC', porção: 'PORC', porc: 'PORC', prc: 'PORC',
};
export function normalizeUnit(raw: string): Normalized<string> {
  const value = UNITS[raw.trim().toLowerCase().replace(/\.$/, '')];
  if (!value) return { ok: false, code: 'unknown_unit', message: `Unidade "${raw.trim()}" não corresponde a UN, KG, G, L, ML, CX, PCT ou PORC.` };
  return value === raw.trim() ? { ok: true, value } : { ok: true, value, rule: 'unit_code', reason: `Unidade "${raw.trim()}" convertida para o código ${value}.` };
}

export function normalizeBarcode(raw: string): Normalized<string> {
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d{4,40}$/.test(digits)) return { ok: false, code: 'invalid_barcode', message: `Código de barras "${raw.trim()}" deve conter apenas dígitos.` };
  // Lost leading zeros are typical spreadsheet damage; EAN length is restored only when the GTIN checksum then validates.
  const padded = digits.length < 14 && !validGtin(digits) ? [8, 12, 13, 14].find(length => digits.length < length && validGtin(digits.padStart(length, '0'))) : undefined;
  const value = padded ? digits.padStart(padded, '0') : digits;
  return value === raw.trim() ? { ok: true, value } : { ok: true, value, rule: 'barcode_digits', reason: 'Código de barras padronizado (espaços/zeros iniciais).' };
}

export type DateOrder = 'dmy' | 'mdy';
// "05/03/2024" is dd/mm in Brazil, but a column is only read as mm/dd when its own values prove it (e.g. a 03/25/2024 somewhere in the column).
export function detectDateOrder(values: string[]): { order: DateOrder; certain: boolean } {
  let dmy = false; let mdy = false; let ambiguous = false;
  for (const raw of values) {
    const match = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec(raw.trim()); if (!match) continue;
    const a = +match[1]; const b = +match[2];
    if (a > 12 && b <= 12) dmy = true; else if (b > 12 && a <= 12) mdy = true; else if (a !== b) ambiguous = true;
  }
  if (dmy && !mdy) return { order: 'dmy', certain: true };
  if (mdy && !dmy) return { order: 'mdy', certain: true };
  return { order: 'dmy', certain: !ambiguous && !dmy && !mdy };
}
export function parseDateValue(raw: string, order: DateOrder = 'dmy'): { iso: string; ambiguous: boolean } | null {
  const text = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(text);
  if (match) return validDate(+match[1], +match[2], +match[3], false);
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(text);
  if (!match) return null;
  const a = +match[1]; const b = +match[2];
  if (a > 12) return validDate(+match[3], b, a, false);
  if (b > 12) return validDate(+match[3], a, b, false);
  return order === 'dmy' ? validDate(+match[3], b, a, a !== b) : validDate(+match[3], a, b, a !== b);
}
function validDate(year: number, month: number, day: number, ambiguous: boolean) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { iso: date.toISOString().slice(0, 10), ambiguous } : null;
}

export function normalizeZip(raw: string): Normalized<string> {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 8) return { ok: false, code: 'invalid_zip', message: `CEP "${raw.trim()}" deve ter 8 dígitos.` };
  const value = digits.padStart(8, '0');
  return value === raw.trim() ? { ok: true, value } : { ok: true, value, rule: 'zip_digits', reason: digits.length === 7 ? 'Zero à esquerda do CEP restaurado (perdido em planilha) e pontuação removida.' : 'Pontuação do CEP removida.' };
}

const STATES: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR', 'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};
const UFS = new Set(Object.values(STATES));
export function normalizeState(raw: string): Normalized<string> {
  const plain = raw.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const value = UFS.has(plain.toUpperCase()) ? plain.toUpperCase() : STATES[plain];
  if (!value) return { ok: false, code: 'invalid_state', message: `Estado "${raw.trim()}" não é uma UF válida.` };
  return value === raw.trim() ? { ok: true, value } : { ok: true, value, rule: 'state_uf', reason: `Estado convertido para a sigla ${value}.` };
}

export function parsePercent(raw: string): Normalized<string> {
  const result = parseDecimal(raw.replace(/%/g, ''), 4);
  return result.ok ? { ...result, ...(raw.includes('%') && !result.rule ? { rule: 'percent_symbol', reason: 'Símbolo % removido.' } : {}) } : result;
}

export function parseFinType(raw: string): 'INCOME' | 'EXPENSE' | null {
  const word = raw.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (['receita', 'receitas', 'entrada', 'receber', 'a receber', 'credito', 'income', 'revenue', 'r', 'c'].includes(word)) return 'INCOME';
  if (['despesa', 'despesas', 'saida', 'pagar', 'a pagar', 'debito', 'expense', 'cost', 'custo', 'd', 'p'].includes(word)) return 'EXPENSE';
  return null;
}

export type EntryStatusWord = 'OPEN' | 'PAID' | 'PARTIAL' | 'CANCELLED';
export function parseEntryStatus(raw: string): { status: EntryStatusWord; overdueWord: boolean } | null {
  const word = raw.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  if (['aberto', 'em aberto', 'aberta', 'pendente', 'a pagar', 'a receber', 'open', 'pending', 'ativo', 'nao pago', 'nao recebido'].includes(word)) return { status: 'OPEN', overdueWord: false };
  if (['vencido', 'vencida', 'atrasado', 'atrasada', 'em atraso', 'overdue'].includes(word)) return { status: 'OPEN', overdueWord: true };
  if (['pago', 'paga', 'quitado', 'quitada', 'baixado', 'baixada', 'recebido', 'recebida', 'liquidado', 'liquidada', 'paid', 'received', 'settled', 'pago total', 'total'].includes(word)) return { status: 'PAID', overdueWord: false };
  if (['parcial', 'parcialmente pago', 'parcialmente paga', 'parcialmente recebido', 'parcialmente recebida', 'pago parcialmente', 'recebido parcialmente', 'partial', 'baixa parcial'].includes(word)) return { status: 'PARTIAL', overdueWord: false };
  if (['cancelado', 'cancelada', 'cancelled', 'canceled', 'estornado', 'estornada', 'anulado', 'anulada', 'excluido', 'excluida'].includes(word)) return { status: 'CANCELLED', overdueWord: false };
  return null;
}

export function parseInstallment(raw: string): { number: number; count: number | null } | null {
  const text = raw.trim();
  const ratio = /^(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})$/i.exec(text);
  if (ratio) return { number: +ratio[1], count: +ratio[2] };
  return /^\d{1,3}$/.test(text) ? { number: +text, count: null } : null;
}
