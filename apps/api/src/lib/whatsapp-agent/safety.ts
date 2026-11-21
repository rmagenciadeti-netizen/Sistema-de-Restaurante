import { normalizeText } from '../whatsapp-text';

// What the customer finally reads. Models like to write Markdown; WhatsApp has its own (*bold*, _italic_), no headings, no tables, no code blocks.
export function cleanReply(raw: string): string {
  return raw
    .replace(/<\/?(?:tool_call|tool_response|function_call|thinking|think)[^>]*>/gi, '')
    .replace(/\[ATENDENTE\]/g, '')
    .replace(/```[a-z]*\n?/gi, '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '_$1_')
    .replace(/^\s*[-•]\s+/gm, '• ').replace(/^\s*---+\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3800);
}

// Name shown by WhatsApp is chosen by the customer: it is data, never an instruction. One short line of plain text.
export const safeName = (name: string | null | undefined) => (name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;

export type Executed = { tool: string; kind: 'READ' | 'MEMORY' | 'WRITE'; ok: boolean; wrote?: 'reservation' | 'order' | 'cancel' | 'modify'; data?: unknown };
type Domain = 'reservation' | 'order' | 'cancel' | 'modify';
const CLAIMS: { domain: Domain; re: RegExp }[] = [
  { domain: 'reservation', re: /\b(reservei|(fiz|registrei|anotei|agendei|criei) (a |uma )?(sua )?reserva|sua reserva (foi|ficou) (feita|realizada|criada|registrada|efetuada|agendada|confirmada)|reserva (feita|realizada|criada|registrada|efetuada) com sucesso)\b/ },
  { domain: 'order', re: /\b((fiz|registrei|anotei|enviei) (o |um )?(seu )?pedido|seu pedido (foi|ficou) (feito|realizado|registrado|criado|efetuado|confirmado|enviado)|pedido (feito|realizado|registrado|criado|efetuado|confirmado) com sucesso)\b/ },
  { domain: 'cancel', re: /\b(cancelei|cancelamos|(sua reserva|seu pedido) foi cancelad[oa]|cancelad[oa] com sucesso)\b/ },
  { domain: 'modify', re: /\b((alterei|atualizei|modifiquei|troquei|inclui|adicionei|removi) (o|seu|sua|a) (pedido|reserva|item)|(pedido|reserva) (foi )?(alterad[oa]|atualizad[oa]|modificad[oa]) com sucesso)\b/ },
];

// The attendant may only say an operation happened when the backend did it in this very turn (or when it just read the real record). Returns the unbacked claims.
export function unbackedClaims(text: string, executed: Executed[], known: { order?: boolean; reservation?: boolean } = {}): Domain[] {
  const normalized = normalizeText(text);
  const wrote = (...kinds: Executed['wrote'][]) => executed.some(item => item.ok && item.wrote && kinds.includes(item.wrote));
  const read = (tool: string) => executed.some(item => item.ok && item.tool === tool);
  const backed: Record<Domain, boolean> = {
    reservation: wrote('reservation', 'modify') || read('get_my_reservations') || Boolean(known.reservation),
    order: wrote('order') || read('get_my_orders') || Boolean(known.order),
    cancel: wrote('cancel') || read('get_my_reservations') || read('get_my_orders'),
    modify: wrote('modify') || read('get_my_reservations') || read('get_my_orders'),
  };
  return CLAIMS.filter(claim => claim.re.test(normalized) && !backed[claim.domain]).map(claim => claim.domain);
}

const brl = (value: unknown) => `R$ ${Number(value).toFixed(2).replace('.', ',')}`;

// ---- Money the attendant may mention: only what the backend (or the customer) really said. ----
const toCents = (reais: number) => Math.round(reais * 100);
const AMOUNT = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)|\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*reais\b/gi;
const PLAIN_MONEY = /\b\d+,\d{2}\b/g;
const parseReais = (raw: string) => Number(raw.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));

// Every amount written in a text, in cents ("R$ 32,90", "R$32.90", "5 reais").
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(AMOUNT)) { const value = parseReais(match[1] ?? match[2]); if (Number.isFinite(value)) out.push(toCents(value)); }
  return out;
}

// Collects every figure a source states (JSON numbers are reais; strings may carry "R$ 5,00" or "5,00"). A tool result, the system prompt and the customer's own words all count.
export function collectAmounts(source: unknown, pool: Set<number>, depth = 0): void {
  if (depth > 8 || source === null || source === undefined) return;
  if (typeof source === 'number') { if (Number.isFinite(source) && Math.abs(source) < 1e7) pool.add(toCents(Math.abs(source))); return; }
  if (typeof source === 'string') {
    for (const cents of amountsIn(source)) pool.add(cents);
    for (const match of source.matchAll(PLAIN_MONEY)) pool.add(toCents(parseReais(match[0])));
    return;
  }
  if (Array.isArray(source)) { for (const item of source) collectAmounts(item, pool, depth + 1); return; }
  if (typeof source === 'object') for (const value of Object.values(source as Record<string, unknown>)) collectAmounts(value, pool, depth + 1);
}

// A written amount is fine when it was stated, or follows from stated ones by simple arithmetic the customer would expect (2 × a unit price, a subtotal plus a fee, a change amount).
// Whole small numbers (quantities, "2", "3") never serve as the basis of a derivation, so they cannot "explain" an arbitrary price.
function derivable(target: number, pool: Set<number>): boolean {
  const bases = [...pool].filter(value => value >= 1000 || value % 100 !== 0).sort((a, b) => a - b).slice(0, 80);
  for (const base of bases) {
    if (target % base === 0 && target / base <= 30) return true;
    if (pool.has(target - base) || pool.has(base - target)) return true;
    for (let times = 2; times <= 9; times += 1) {
      const rest = target - times * base;
      if (rest > 0 && (pool.has(rest) || bases.some(other => rest % other === 0 && rest / other <= 9))) return true;
    }
  }
  return false;
}

// Amounts in the reply that no tool result, prompt data or customer message supports. The attendant must look values up, never invent, estimate or round them.
export function unbackedAmounts(text: string, pool: Set<number>): number[] {
  return [...new Set(amountsIn(text))].filter(cents => cents > 0 && !pool.has(cents) && !derivable(cents, pool));
}

// Did the attendant just say, nearly word for word, what it said last time — to a customer who wrote something new? That is how a robot gets "stuck".
export function repeatsLastReply(text: string, lastReply: string | undefined, question: string, lastQuestion: string | undefined): boolean {
  if (!lastReply || lastQuestion === undefined) return false;
  const words = (value: string) => normalizeText(value).split(' ').filter(word => word.length > 2);
  const a = words(text); const b = words(lastReply);
  if (a.length < 4 || b.length < 4) return false;
  const shared = a.filter(word => b.includes(word)).length;
  const similar = shared / Math.max(a.length, b.length) >= 0.9;
  return similar && normalizeText(question) !== normalizeText(lastQuestion);
}
// Used only when the model cannot write the final message after a real operation succeeded: the customer must never be left without the outcome.
export function receiptFor(executed: Executed[]): string | null {
  const done = executed.filter(item => item.ok && item.wrote && !(item.data as { simulated?: boolean } | undefined)?.simulated).at(-1);
  if (!done) return null;
  const d = (done.data ?? {}) as Record<string, unknown>;
  if (done.wrote === 'reservation') return `✅ Reserva registrada: ${d.partySize} pessoa(s), ${d.when}${d.name ? `, em nome de ${d.name}` : ''}. ${d.reservationStatus === 'CONFIRMED' ? 'Já está confirmada.' : 'Ela fica aguardando a confirmação da equipe, que avisaremos por aqui.'}`;
  if (done.wrote === 'order') return `✅ Pedido ${d.ref} registrado! Total ${brl(d.total)}${d.scheduledFor ? `, agendado para ${d.scheduledFor}` : ''}. Vamos avisar por aqui quando houver novidades.`;
  if (done.wrote === 'cancel') return `✅ Cancelamento realizado${d.ref ? ` (pedido ${d.ref})` : ''}.`;
  if (done.wrote === 'modify') return `✅ Alteração realizada${d.ref ? ` no pedido ${d.ref}` : ''}${d.newTotal ? `. Novo total: ${brl(d.newTotal)}` : d.when ? `. Nova data: ${d.when}` : ''}.`;
  return null;
}
