import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ACTIVE_RESERVATION_STATUSES, openingHoursCheck, RESERVATION_WINDOW_MS } from './reservations';
import { serializable } from './serializable';
import { last8 } from './whatsapp-auto';
import {
  aiAnswer, deliveryInfo, hoursInfo, hoursText, knowledgeMatches, loadMenu, mentionsPaymentMethod, menuText, orderStatusReply, paymentInfo, priceLabel, promoInfo, recordUnanswered, reservationStatusReply, welcome,
  type BotEnv, type MenuData,
} from './whatsapp-bot';
import { canonical, detectTopics, isGreetingOnly, isNo, isYes, menuChoice, parsePeople, startsWithGreeting, wantsToResume, wantsToStop, weekdaysIn, type Detected, type Topic } from './whatsapp-intents';
import { renderTemplate } from './whatsapp-messages';
import { chunkMessage, distinctiveWords, extractWhen, formatLocal, matchScore, normalizeText, parseWhen, samePhone } from './whatsapp-text';

type Db = PrismaClient | Prisma.TransactionClient;

// What the classic bot remembers between messages of one conversation. The reservation draft never blocks the conversation: it waits (and is parked after
// two reminders) while the customer asks other things, and comes back when the customer gives the missing data or asks to continue.
export const botStateSchema = z.object({
  step: z.enum(['RESERVE_PEOPLE', 'RESERVE_WHEN', 'RESERVE_CONFIRM']).optional(),
  people: z.number().int().optional(), at: z.string().max(40).optional(), day: z.string().max(40).optional(), time: z.string().max(8).optional(),
  nudges: z.number().int().min(0).max(10).optional(), paused: z.boolean().optional(), stamp: z.string().max(40).optional(),
  unknown: z.number().int().min(0).max(10).optional(), last: z.string().max(40).optional(), topic: z.string().max(30).optional(), menu: z.boolean().optional(),
}).nullable();
export type BotState = z.infer<typeof botStateSchema>;
export type BotInput = { text: string; phone: string | null; name: string | null; state: BotState; firstContact?: boolean; greetDue?: boolean };
export type BotResult = { replies: string[]; state: BotState; intent: string; intents: string[]; handoff: boolean; optOut?: boolean; optIn?: boolean; greeted?: boolean };
export type BotOptions = { dryRun?: boolean; now?: Date };

type S = NonNullable<BotState>;
type Step = NonNullable<S['step']>;
type Draft = { people?: number; day?: string; time?: string; at?: string };

// A booking in progress is forgotten after six hours of silence; misunderstandings and "what we talked about" after half an hour.
const FLOW_TTL_MS = 6 * 3_600_000;
const CHAT_TTL_MS = 30 * 60_000;
const MAX_NUDGES = 2;
const MAX_PEOPLE = 20;
const MESSAGE_SOFT_LIMIT = 1200;
// Legal command: it must work even in the middle of a booking, but only when that is all the customer said.
const OPT_OUT = /^(parar|stop|sair|descadastrar|cancelar mensagens|sair da lista|nao quero (mais )?receber( mensagens| avisos)?|(quero )?parar de receber( mensagens| avisos)?|para de (me )?(mandar|enviar) mensagens?)$/;
const WHEN_HELP = 'Para qual dia e horário? (ex.: *25/12 20:00*, *amanhã 19h30* ou *sábado 21h*)';
const HINTS = { NO_TIME: 'Não entendi o horário.', NO_DATE: 'Não entendi o dia.', INVALID: 'Data ou horário inválido.', PAST: 'Esse horário já passou ou é muito próximo (mínimo 30 minutos).', TOO_FAR: 'Só aceitamos reservas para os próximos 90 dias.' };
const DAY_LABEL: Record<string, string> = { amanha: 'amanhã', sabado: 'sábado', terca: 'terça', 'terca-feira': 'terça-feira', 'depois de amanha': 'depois de amanhã' };
const dayLabel = (day: string) => DAY_LABEL[day] ?? day;
const INTENT_OF: Record<Topic, string> = { handoff: 'handoff', thanks: 'thanks', order_status: 'order_status', reservation_status: 'reservation_status', cancel_existing: 'handoff', reserve: 'reserve', order: 'order_link', address: 'address', hours: 'hours', delivery: 'delivery', payment: 'payment', promo: 'promo', menu: 'menu_items' };
// Answers that may be asked twice on purpose; repeating one word for word is flagged so the customer knows it is a repeat, not a loop.
const INFORMATIONAL = new Set(['address', 'hours', 'delivery', 'payment', 'promo', 'menu_items', 'order_link', 'order_status', 'reservation_status', 'knowledge', 'category', 'product']);

function freshState(raw: BotState, now: Date): S {
  const state: S = { ...(raw ?? {}) };
  const stamp = state.stamp ? Date.parse(state.stamp) : NaN;
  const idle = Number.isNaN(stamp) ? 0 : now.getTime() - stamp;
  if (idle > FLOW_TTL_MS) { delete state.step; delete state.people; delete state.day; delete state.time; delete state.at; delete state.nudges; delete state.paused; }
  if (idle > CHAT_TTL_MS) { delete state.unknown; delete state.last; delete state.topic; delete state.menu; }
  return state;
}

const fingerprint = (replies: string[]) => createHash('sha1').update(replies.join('\u0000')).digest('hex').slice(0, 16);

// Merges whatever the message says about the booking into the draft. `changed` tells a real correction apart from a customer repeating what we already have.
// Day and time words are only taken when the message is about the booking: "vocês abrem hoje às 11h?" asks about opening hours, it does not move the reservation.
function absorb(draft: Draft, c: string, text: string, bare: boolean, allowWhen: boolean) {
  const people = parsePeople(c, bare);
  const when = allowWhen ? extractWhen(text) : {};
  let found = false; let changed = false;
  const set = <K extends keyof Draft>(key: K, value: Draft[K] | undefined | null) => { if (value === undefined || value === null) return; found = true; if (draft[key] !== value) { draft[key] = value; changed = true; } };
  set('people', people); set('day', when.day); set('time', when.time);
  return { found, changed, invalid: Boolean('invalid' in when && when.invalid) };
}

type Plan = { step: Step; text: string; handoff?: boolean };
const whenSummary = (draft: Draft) => [draft.day && dayLabel(draft.day), draft.time && `às ${draft.time}`].filter(Boolean).join(' ');

// The next thing to ask (or the confirmation), given what the draft already holds. Impossible dates and closed hours clear the offending part and say why.
function plan(draft: Draft, env: BotEnv, now: Date, lead = ''): Plan {
  const tz = env.settings.hours.timezone;
  if (draft.people === undefined) return { step: 'RESERVE_PEOPLE', text: `${lead}${whenSummary(draft) ? `Anotei ${whenSummary(draft)}. ` : ''}Para quantas pessoas?` };
  if (draft.people > MAX_PEOPLE) return { step: 'RESERVE_PEOPLE', text: 'Para grupos acima de 20 pessoas um atendente precisa ajudar. Já estou chamando! 🙋', handoff: true };
  if (draft.people < 1) { draft.people = undefined; return { step: 'RESERVE_PEOPLE', text: `${lead}Para quantas pessoas? Responda só com o número (ex.: 4).` }; }
  if (!draft.day && !draft.time) return { step: 'RESERVE_WHEN', text: `${lead || 'Perfeito! '}${WHEN_HELP}` };
  if (!draft.day) return { step: 'RESERVE_WHEN', text: `${lead}Anotei *${draft.time}*. Para qual dia? (ex.: *amanhã*, *sábado* ou *25/12*)` };
  if (!draft.time) return { step: 'RESERVE_WHEN', text: `${lead}Anotei *${dayLabel(draft.day)}*. Que horário? (ex.: *20h* ou *19:30*)` };
  const parsed = parseWhen(`${draft.day} ${draft.time}`, tz, now);
  const retry = (message: string): Plan => { draft.day = undefined; draft.time = undefined; draft.at = undefined; return { step: 'RESERVE_WHEN', text: message }; };
  if ('error' in parsed) return retry(`${HINTS[parsed.error]} Envie no formato *dia/mês hora:minuto*, por exemplo *25/12 20:00*.`);
  const open = openingHoursCheck(env.settings.hours, parsed.at);
  if (!open.ok) return retry(`${open.message} Qual outro dia ou horário prefere?`);
  draft.at = parsed.at.toISOString();
  return { step: 'RESERVE_CONFIRM', text: `${lead}Confirma a reserva para *${draft.people} pessoa(s)* em *${formatLocal(parsed.at, tz)}*?\nResponda *sim* para confirmar ou *cancelar*.` };
}

const reminder = (state: S, env: BotEnv) => {
  if (state.step === 'RESERVE_CONFIRM' && state.at) return `Sua reserva para *${state.people} pessoa(s)* em *${formatLocal(new Date(state.at), env.settings.hours.timezone)}* continua aguardando: responda *sim* para confirmar ou *cancelar*.`;
  if (state.step === 'RESERVE_WHEN') return `Sobre a sua reserva${state.people ? ` (${state.people} pessoa(s))` : ''}: qual dia e horário prefere?`;
  return 'Quando quiser seguir com a reserva, é só me dizer para quantas pessoas. 🪑';
};
const PARKED = 'Deixei sua reserva guardada. Quando quiser continuar, é só dizer *continuar reserva*. 😉';

const isClient = (db: Db): db is PrismaClient => '$transaction' in db;

// Registers the booking once. The same customer asking twice (or confirming twice, even at the very same instant) never creates two reservations:
// the check and the insert run in one serializable transaction, and the loser of a race re-checks and finds the first one.
async function book(db: Db, env: BotEnv, input: BotInput, draft: Draft, dryRun: boolean): Promise<string> {
  const tz = env.settings.hours.timezone;
  const at = new Date(draft.at!);
  if (!env.unitId) return 'Não consegui registrar sua reserva automaticamente. Já chamei um atendente. 🙋';
  const unitId = env.unitId;
  const work = async (tx: Db) => {
    if (input.phone) {
      const existing = (await tx.reservation.findMany({ where: { tenantId: env.tenantId, phone: { endsWith: last8(input.phone) }, status: { in: ACTIVE_RESERVATION_STATUSES }, reservedAt: { gt: new Date(at.getTime() - RESERVATION_WINDOW_MS), lt: new Date(at.getTime() + RESERVATION_WINDOW_MS) } }, take: 5 })).filter(row => samePhone(row.phone, input.phone));
      if (existing.length) return `Você já tem uma reserva registrada para ${existing[0].partySize} pessoa(s) em ${formatLocal(existing[0].reservedAt, tz)}. Para alterar, digite *atendente*. 🙋`;
    }
    if (!dryRun) await tx.reservation.create({ data: { tenantId: env.tenantId, unitId, customerName: input.name ?? 'Cliente WhatsApp', phone: input.phone, partySize: draft.people!, reservedAt: at, notes: 'Solicitada pelo WhatsApp' } });
    return `✅ Pedido de reserva recebido para ${draft.people} pessoa(s) em ${formatLocal(at, tz)}. Você receberá a confirmação por aqui assim que a equipe validar.${dryRun ? '\n(simulação: nenhuma reserva foi criada)' : ''}`;
  };
  return isClient(db) && !dryRun ? serializable(db, work) : work(db);
}

// Short messages are packed together; a long one (the menu) keeps its own bubbles.
function pack(blocks: string[]): string[] {
  const out: string[] = []; let current = '';
  for (const block of blocks.filter(Boolean)) {
    if (current && current.length + block.length + 2 > MESSAGE_SOFT_LIMIT) { out.push(current); current = block; } else current = current ? `${current}\n\n${block}` : block;
  }
  if (current) out.push(current);
  return out.flatMap(message => chunkMessage(message));
}

const stripMatches = (c: string, found: Detected[]) => found.reduce((text, item) => text.replace(item.match, ' '), c).replace(/\s+/g, ' ').trim();

// Decides the replies to one customer message using real tenant data. Intent first: every message is read for what it asks, whatever was asked before.
// With `dryRun` nothing is written (used by the simulator).
export async function respond(db: Db, env: BotEnv, input: BotInput, options: BotOptions = {}): Promise<BotResult> {
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const text = input.text.trim().slice(0, 1000);
  const normalized = normalizeText(text);
  const c = canonical(text);
  const tz = env.settings.hours.timezone;
  const name = input.name?.split(' ')[0] ?? null;
  const state = freshState(input.state, now);
  const flow = state.step;
  const closedNote = !env.open && env.settings.whatsapp.replyOutsideHours && env.templates('out_of_hours').enabled && env.settings.whatsapp.autoMessagesEnabled
    ? renderTemplate(env.templates('out_of_hours').body, { restaurante: env.restaurant, horario: hoursText(env) }) : null;
  const handoffText = () => renderTemplate(env.templates('handoff').body, { nome: name ?? 'cliente', restaurante: env.restaurant });

  const done = (intents: string[], blocks: string[], next: S | null, extra: Partial<BotResult> = {}): BotResult => {
    let replies = pack(blocks);
    let saved: BotState = null;
    if (next) {
      const reply = fingerprint(replies);
      if (state.last === reply && intents.every(intent => INFORMATIONAL.has(intent))) replies = [`Claro, segue novamente:\n\n${replies[0]}`, ...replies.slice(1)];
      saved = { ...next, last: reply, stamp: now.toISOString(), topic: intents[0] };
      for (const field of Object.keys(saved) as (keyof S)[]) if (saved[field] === undefined || saved[field] === false || saved[field] === 0) delete saved[field];
    }
    return { replies, state: saved, intent: intents[0], intents, handoff: false, ...extra };
  };

  if (OPT_OUT.test(c)) return done(['opt_out'], ['Tudo bem! Você não receberá mais mensagens automáticas. Para voltar a receber, envie *voltar*.'], null, { optOut: true });
  const bareBack = /^(voltar|iniciar|retomar)$/.test(normalized);
  if (bareBack && !flow) return done(['opt_in'], ['Pronto! Voltaremos a enviar avisos dos seus pedidos. 😊', menuText(env)], null, { optIn: true });

  // ---- what is the customer asking? ----
  const found = detectTopics(c);
  const digit = menuChoice(c);
  // A lone number answers "para quantas pessoas?" while that question is open; otherwise it picks a numbered option.
  const digitAnswersFlow = flow === 'RESERVE_PEOPLE' && !state.menu;
  let topics: Topic[] = digit && !digitAnswersFlow ? [digit] : found.map(item => item.topic);
  // "e sábado?" after a question about hours, "e cartão?" after one about payment.
  if (topics.length === 0 && state.topic === 'hours' && weekdaysIn(c).length) topics = ['hours'];
  if (topics.length === 0 && state.topic === 'payment' && mentionsPaymentMethod(c)) topics = ['payment'];

  if (topics.includes('handoff')) return done(['handoff'], [handoffText()], null, { handoff: true });

  const draftOnly = Boolean(flow) && /\breserva\b/.test(c) && !/\bpedido\b/.test(c);
  if (topics.includes('cancel_existing') && !draftOnly) {
    return done(['handoff'], ['Para cancelar ou alterar algo que já foi registrado eu preciso da equipe. Já estou chamando um atendente para você. 🙋'], null, { handoff: true });
  }

  // ---- booking in progress ----
  const draft: Draft = { people: state.people, day: state.day, time: state.time, at: state.at };
  const next: S = { ...state };
  const blocks: string[] = []; const intents: string[] = [];
  let progressed = false; let flowText: string | null = null; let finished = false; let understood = false;
  const carriesData = Boolean(flow) && (parsePeople(c, false) !== null || Boolean(extractWhen(text).day || extractWhen(text).time));
  const stop = Boolean(flow) && (wantsToStop(c) || (isNo(c) && !carriesData));
  if (stop) return done(['reserve_cancel'], ['Tudo bem, não vou registrar essa reserva. 👍 Posso ajudar em algo mais?', menuText(env)], { menu: true });

  const startsReservation = !flow && topics.includes('reserve');
  if (flow || startsReservation) {
    const aboutOthers = topics.some(topic => topic !== 'reserve' && topic !== 'thanks');
    const bookingWords = /\b(reserva|reservar|mesa)\b/.test(c);
    const absorbed = absorb(draft, c, text, flow === 'RESERVE_PEOPLE' && !state.menu, !aboutOthers || bookingWords);
    const resume = Boolean(flow) && (wantsToResume(c) || bareBack || topics.includes('reserve'));
    const confirming = flow === 'RESERVE_CONFIRM' && Boolean(draft.at) && isYes(c) && !absorbed.changed && !absorbed.invalid;
    if (confirming) {
      flowText = await book(db, env, input, draft, dryRun);
      intents.push('reserve_done'); finished = true; progressed = true;
    } else if (absorbed.invalid) {
      draft.time = undefined; draft.at = undefined;
      flowText = `${HINTS.INVALID} Envie o horário assim: *20h* ou *19:30*.`; next.step = draft.people === undefined ? 'RESERVE_PEOPLE' : 'RESERVE_WHEN'; intents.push('reserve'); progressed = true;
    } else if ((absorbed.found && (flow !== 'RESERVE_CONFIRM' || absorbed.changed)) || startsReservation || resume) {
      const lead = startsReservation && !absorbed.found ? '🪑 Vamos reservar! ' : resume && !absorbed.found ? 'Certo, vamos retomar a sua reserva. ' : '';
      const p = plan(draft, env, now, lead);
      if (p.handoff) return done(['handoff'], [p.text], null, { handoff: true });
      flowText = p.text; next.step = p.step; intents.push('reserve'); progressed = true;
    }
    understood = progressed;
    if (progressed && !finished) { next.people = draft.people; next.day = draft.day; next.time = draft.time; next.at = draft.at; next.nudges = 0; next.paused = false; }
    if (finished) { for (const field of ['step', 'people', 'day', 'time', 'at', 'nudges', 'paused'] as const) delete next[field]; }
  }

  // ---- the subjects of the message, in the order they were asked ----
  let menuData: MenuData | null = null;
  const menu = async () => (menuData ??= await loadMenu(db, env, now));
  const replaced = new Set<Topic>();
  // Every answer remembers where in the message its question was, so the replies come back in the order the customer asked.
  const answers: { at: number; text: string; intent: string }[] = [];
  const positionOf = (words: string[]) => { const spots = words.map(word => c.indexOf(word)).filter(spot => spot >= 0); return spots.length ? Math.min(...spots) : Number.MAX_SAFE_INTEGER; };
  const knowledge = await knowledgeMatches(db, env.tenantId, text);
  for (const { entry, hits } of knowledge) {
    answers.push({ at: positionOf(hits), text: entry.answer, intent: 'knowledge' }); understood = true;
    for (const item of found) if (hits.some(hit => hit.includes(item.match) || item.match.includes(hit))) replaced.add(item.topic);
    if (!dryRun) await db.whatsappKnowledge.update({ where: { id: entry.id }, data: { hits: { increment: 1 } } });
  }
  const greeting = isGreetingOnly(c) && topics.length === 0;
  for (const topic of topics) {
    if (replaced.has(topic) || topic === 'reserve' || topic === 'handoff' || topic === 'cancel_existing') continue;
    if (topic === 'thanks' && (topics.length > 1 || answers.length > 0 || progressed)) continue;
    const at = found.find(item => item.topic === topic)?.at ?? 0;
    let reply: string;
    if (topic === 'address') reply = env.address ? `📍 *Endereço*\n${env.address}${env.settings.company.phone ? `\n📞 ${env.settings.company.phone}` : ''}` : 'Ainda não temos o endereço cadastrado por aqui. Digite *atendente* que informamos. 🙋';
    else if (topic === 'hours') reply = [hoursInfo(env, c), env.address ? `📍 ${env.address}` : ''].filter(Boolean).join('\n\n');
    else if (topic === 'delivery') reply = await deliveryInfo(db, env, c);
    else if (topic === 'payment') reply = await paymentInfo(db, env, c);
    else if (topic === 'promo') reply = promoInfo(env, await menu());
    else if (topic === 'order_status') reply = await orderStatusReply(db, env, text, input.phone, now);
    else if (topic === 'reservation_status') reply = await reservationStatusReply(db, env, input.phone, now);
    else if (topic === 'order') reply = env.storeUrl ? `🛒 Faça seu pedido online por aqui:\n${env.storeUrl}\n\nSe preferir, me diga o que deseja e chamo um atendente.` : 'Para fazer seu pedido, digite *atendente* e vamos anotar por aqui. 🙋';
    else if (topic === 'thanks') reply = 'Por nada! Qualquer dúvida é só chamar. 💛';
    else if (topic === 'menu') {
      const data = await menu();
      reply = data.categories.length === 0 ? 'Ainda não temos itens cadastrados no cardápio por aqui. Digite *atendente*. 🙋'
        : `📋 *Cardápio ${env.restaurant}*\n\n${data.categories.map(category => `*${category.name}*\n${category.products.map(item => `• ${item.name} — ${priceLabel(item)}`).join('\n')}`).join('\n\n')}${env.storeUrl ? `\n\n🛒 Peça online: ${env.storeUrl}` : ''}`;
    } else continue;
    answers.push({ at, text: reply, intent: INTENT_OF[topic] }); understood = true;
  }

  // Products and categories named in the message (what is left once the other subjects are taken out).
  if (!topics.includes('menu') && !topics.includes('reserve') && !progressed && !digit && !isYes(c) && !isNo(c)) {
    const residual = stripMatches(c, found);
    const data = await menu();
    const named = distinctiveWords(residual);
    const category = data.categories.find(item => normalizeText(item.name).length >= 3 && matchScore(residual, item.name) >= 1.5 && named.length <= 3);
    if (category) {
      answers.push({ at: positionOf(named), text: `🍽️ *${category.name}*\n${category.products.map(item => `• *${item.name}* — ${priceLabel(item)}${item.description ? `\n  _${item.description.slice(0, 90)}_` : ''}`).join('\n')}${env.storeUrl ? `\n\nPeça em: ${env.storeUrl}` : ''}`, intent: 'category' }); understood = true;
    } else {
      const scored = data.flat.map(item => ({ item, score: matchScore(residual, item.name) })).filter(entry => entry.score >= 1).sort((a, b) => b.score - a.score);
      if (scored.length > 0 && named.length > 0) {
        const top = scored.filter(entry => entry.score >= scored[0].score - 0.01).slice(0, 5);
        answers.push({ at: positionOf(named), text: `${top.length === 1 ? 'Sim, temos!' : 'Encontrei estas opções:'}\n${top.map(({ item }) => `• *${item.name}* — ${priceLabel(item)}${item.description ? `\n  _${item.description.slice(0, 120)}_` : ''}`).join('\n')}${env.storeUrl ? `\n\n🛒 ${env.storeUrl}` : ''}`, intent: 'product' }); understood = true;
      }
    }
  }
  for (const answer of answers.sort((a, b) => a.at - b.at)) { blocks.push(answer.text); intents.push(answer.intent); }

  // ---- greeting ----
  let greeted = false; let menuShown = false;
  if (greeting) {
    if (flow && !progressed) { blocks.push(`Olá${name ? `, ${name}` : ''}! 😊`); intents.push('greeting'); }
    else if (input.greetDue) {
      blocks.push(env.settings.whatsapp.autoMessagesEnabled && env.templates('welcome').enabled ? welcome(env, name) : menuText(env));
      if (closedNote) blocks.push(closedNote);
      intents.push('welcome'); greeted = true; menuShown = true;
    } else { blocks.push(`Como posso ajudar, ${name ?? 'cliente'}?\n${menuText(env)}`); intents.push('menu'); greeted = true; menuShown = true; }
    understood = true;
  } else if (input.greetDue && startsWithGreeting(c) && blocks.length + (flowText ? 1 : 0) > 0) {
    if (blocks.length > 0) blocks[0] = `Olá${name ? `, ${name}` : ''}! 😊\n\n${blocks[0]}`; else flowText = `Olá${name ? `, ${name}` : ''}! 😊\n\n${flowText}`;
    greeted = true;
  }

  // ---- the open booking after an answer to something else: remind once, then park it ----
  if (flow && next.step && !progressed && !finished) {
    if (understood) {
      const nudges = (state.nudges ?? 0) + 1;
      if (!state.paused) { if (nudges >= MAX_NUDGES) { next.paused = true; flowText = PARKED; } else flowText = reminder(next, env); }
      next.nudges = nudges;
    } else if ((state.unknown ?? 0) >= 1) {
      next.paused = true; next.unknown = 0;
      return done(['fallback'], ['Desculpe, não consegui entender. 😅 Deixei sua reserva guardada: quando quiser continuar, diga *continuar reserva*.', menuText(env)], { ...next, menu: true });
    } else {
      const p = plan({ ...draft }, env, now);
      next.unknown = 1;
      return done(['reserve'], [`Desculpe, não entendi. 😅 ${p.text}`], next);
    }
  }

  if (blocks.length === 0 && !flowText) {
    // Nothing recognised: the AI helper (when enabled) answers from the restaurant's own data; otherwise the customer is helped, then offered a person, never looped.
    if (env.settings.whatsapp.aiFallback) {
      const answer = await aiAnswer(db, env, text, await menu());
      if (answer) {
        const handoff = answer.includes('[ATENDENTE]');
        const clean = answer.replace(/\[ATENDENTE\]/g, '').trim();
        if (handoff) return done(['ai'], [clean || handoffText()], null, { handoff: true });
        return done(['ai'], [clean || handoffText()], { ...next, unknown: 0 });
      }
    }
    if (!dryRun) await recordUnanswered(db, env.tenantId, text, now);
    const misses = state.unknown ?? 0;
    if (misses === 0) return done(['fallback'], [renderTemplate(env.templates('fallback').body, { nome: name ?? 'cliente', menu: menuText(env) })], { ...next, unknown: 1, menu: true });
    if (misses === 1) return done(['fallback'], ['Desculpe, ainda não consegui entender. 😅 Pode escrever de outra forma? Se preferir, digite *atendente* e uma pessoa ajuda você.'], { ...next, unknown: 2 });
    return done(['handoff'], [handoffText()], null, { handoff: true });
  }

  next.unknown = 0;
  next.menu = menuShown;
  const unique = [...new Set(intents)];
  return done(unique.length ? unique : ['reply'], [...blocks, ...(flowText ? [flowText] : [])], next, greeted ? { greeted: true } : {});
}
