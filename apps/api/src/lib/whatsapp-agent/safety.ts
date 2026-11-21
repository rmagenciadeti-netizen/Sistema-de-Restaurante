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
