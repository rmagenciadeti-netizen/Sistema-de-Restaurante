import { ReservationStatus } from '@prisma/client';
import { z } from 'zod';
import { findFreeTable, RESERVATION_WINDOW_MS, ACTIVE_RESERVATION_STATUSES, unitHasTables } from '../../reservations';
import { localParts } from '../../scheduling';
import { serializable } from '../../serializable';
import { last8 } from '../../whatsapp-auto';
import { samePhone } from '../../whatsapp-text';
import { touch } from '../memory';
import { defineTool, type ToolContext, type ToolDef } from '../types';
import { consumePending, requireConfirmation } from './confirm';
import { dateField, describeInstant, fail, needPhone, ok, timeField, toInstant, tzOf, verifiedPhone, WEEKDAYS } from './common';

const MIN_LEAD_MS = 30 * 60_000; const MAX_AHEAD_MS = 90 * 86_400_000;
type Instant = ReturnType<typeof describeInstant>;

// Is the restaurant open at this local day/time? (Only the weekly schedule mode restricts reservations.)
function withinHours(ctx: ToolContext, at: Date): { ok: true } | { ok: false; code: 'CLOSED' | 'OUTSIDE_HOURS'; message: string } {
  const { hours } = ctx.env.settings;
  if (hours.mode === 'CLOSED') return { ok: false, code: 'CLOSED', message: 'O restaurante está temporariamente fechado e não está aceitando reservas agora.' };
  if (hours.mode === 'OPEN') return { ok: true };
  const p = localParts(at, hours.timezone);
  const slots = hours.weekly.filter(slot => slot.day === p.weekday);
  const mins = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  if (slots.some(slot => p.minutes >= mins(slot.start) && p.minutes <= mins(slot.end))) return { ok: true };
  return { ok: false, code: 'OUTSIDE_HOURS', message: slots.length ? `Nesse dia (${WEEKDAYS[p.weekday]}) o restaurante funciona ${slots.map(slot => `das ${slot.start} às ${slot.end}`).join(' e ')}.` : `O restaurante não abre ${WEEKDAYS[p.weekday]}.` };
}

export type SlotResult =
  | { ok: true; at: Date; table: { id: string; label: string; seats: number } | null; needsStaff: boolean }
  | { ok: false; code: string; message: string; alternatives?: Instant[]; needsHuman?: boolean };

export async function evaluateSlot(ctx: ToolContext, args: { at: Date; partySize: number; ignoreId?: string }): Promise<SlotResult> {
  const { at, partySize } = args;
  if (!ctx.unitId) return { ok: false, code: 'NO_UNIT', message: 'O restaurante não tem unidade ativa para reservas.', needsHuman: true };
  if (partySize > ctx.agent.maxPartySize) return { ok: false, code: 'PARTY_TOO_LARGE', message: `Pelo atendimento automático as reservas vão até ${ctx.agent.maxPartySize} pessoas. Para grupos maiores a equipe precisa combinar com o cliente.`, needsHuman: true };
  if (at.getTime() < ctx.now.getTime() + MIN_LEAD_MS) return { ok: false, code: 'PAST', message: 'Esse horário já passou ou é muito próximo (mínimo de 30 minutos de antecedência).' };
  if (at.getTime() > ctx.now.getTime() + MAX_AHEAD_MS) return { ok: false, code: 'TOO_FAR', message: 'Só aceitamos reservas para os próximos 90 dias.' };
  const hours = withinHours(ctx, at);
  if (!hours.ok) return { ok: false, code: hours.code, message: hours.message };
  if (!await unitHasTables(ctx.db, ctx.tenantId, ctx.unitId)) return { ok: true, at, table: null, needsStaff: true };
  const table = await findFreeTable(ctx.db, { tenantId: ctx.tenantId, unitId: ctx.unitId, partySize, at, ignoreId: args.ignoreId });
  if (table) return { ok: true, at, table, needsStaff: false };
  const alternatives: Instant[] = [];
  for (const minutes of [-120, -90, -60, -30, 30, 60, 90, 120, 180].sort((a, b) => Math.abs(a) - Math.abs(b))) {
    const candidate = new Date(at.getTime() + minutes * 60_000);
    if (candidate.getTime() < ctx.now.getTime() + MIN_LEAD_MS || !withinHours(ctx, candidate).ok) continue;
    if (await findFreeTable(ctx.db, { tenantId: ctx.tenantId, unitId: ctx.unitId, partySize, at: candidate, ignoreId: args.ignoreId })) alternatives.push(describeInstant(candidate, tzOf(ctx)));
    if (alternatives.length >= 3) break;
  }
  return { ok: false, code: 'NO_TABLE', message: `Não há mesa livre para ${partySize} pessoa(s) nesse horário.`, alternatives };
}

const slotFailure = (r: Extract<SlotResult, { ok: false }>) => ({ ...fail(r.code, r.message), data: { alternatives: r.alternatives?.map(a => a.human) ?? [], needsHuman: r.needsHuman ?? false } });

async function myReservations(ctx: ToolContext, includePast = false) {
  const phone = verifiedPhone(ctx);
  if (!phone) return [];
  const rows = await ctx.db.reservation.findMany({ where: { tenantId: ctx.tenantId, phone: { endsWith: last8(phone) }, status: { in: ACTIVE_RESERVATION_STATUSES }, reservedAt: { gte: new Date(ctx.now.getTime() - (includePast ? 24 : 3) * 3_600_000) } }, orderBy: { reservedAt: 'asc' }, take: 20 });
  return rows.filter(row => samePhone(row.phone, phone));
}
const reservationView = (ctx: ToolContext, row: { id: string; partySize: number; reservedAt: Date; status: ReservationStatus; notes: string | null }) => ({ reservationId: row.id, when: describeInstant(row.reservedAt, tzOf(ctx)).human, date: describeInstant(row.reservedAt, tzOf(ctx)).date, time: describeInstant(row.reservedAt, tzOf(ctx)).time, partySize: row.partySize, reservationStatus: row.status, statusMeaning: row.status === 'PENDING' ? 'registrada, aguardando confirmação da equipe' : row.status === 'CONFIRMED' ? 'confirmada pela equipe' : 'cliente já está na mesa', notes: row.notes });

const slotFields = { date: dateField.describe('dia da reserva, AAAA-MM-DD (use o calendário do contexto)'), time: timeField.describe('hora da reserva, HH:mm no fuso do restaurante'), partySize: z.number().int().min(1).max(500).describe('número de pessoas') };

export const checkReservationAvailability = defineTool({
  name: 'check_reservation_availability', kind: 'READ', capability: 'reservations',
  schema: z.object(slotFields),
  description: 'Verifica se dá para reservar nesse dia, hora e número de pessoas: horário de funcionamento, antecedência, limite do restaurante e mesa livre. Se não houver vaga, devolve horários próximos realmente livres.',
  async run(ctx, args) {
    const r = await evaluateSlot(ctx, { at: toInstant(args.date, args.time, tzOf(ctx)), partySize: args.partySize });
    if (!r.ok) return slotFailure(r);
    return ok({ available: true, when: describeInstant(r.at, tzOf(ctx)).human, partySize: args.partySize, needsStaffConfirmation: r.needsStaff || !ctx.agent.autoConfirmReservations }, 'Há disponibilidade');
  },
});

const draftSchema = z.object({ partySize: slotFields.partySize.optional(), date: slotFields.date.optional(), time: slotFields.time.optional(), name: z.string().trim().max(80).optional().describe('nome para a reserva'), notes: z.string().trim().max(300).optional().describe('observações (aniversário, cadeirinha, área...)'), clear: z.boolean().optional() });
export const updateReservationDraft = defineTool({
  name: 'update_reservation_draft', kind: 'MEMORY', capability: 'reservations', schema: draftSchema,
  description: 'Guarda os dados da reserva em andamento (pessoas, dia, hora, nome, observações) conforme o cliente os informa, em qualquer ordem e a qualquer momento da conversa, e diz o que falta. Quando já houver pessoas, dia e hora, verifica a disponibilidade na hora.',
  async run(ctx, args) {
    const r = ctx.memory.reservation;
    if (args.clear) ctx.memory.reservation = { lastReservationId: r.lastReservationId, lastReservationSummary: r.lastReservationSummary };
    const d = ctx.memory.reservation;
    if (args.partySize !== undefined) d.partySize = args.partySize;
    if (args.date) d.date = args.date; if (args.time) d.time = args.time;
    if (args.name) d.name = args.name; if (args.notes) d.notes = args.notes;
    d.updatedAt = touch(ctx.now);
    const name = d.name ?? ctx.memory.profile.name ?? ctx.customer.name;
    const missing = [!d.partySize && 'número de pessoas', !d.date && 'dia', !d.time && 'horário', !name && 'nome para a reserva'].filter(Boolean) as string[];
    let availability: unknown = null;
    if (d.partySize && d.date && d.time) {
      const result = await evaluateSlot(ctx, { at: toInstant(d.date, d.time, tzOf(ctx)), partySize: d.partySize });
      availability = result.ok ? { available: true, when: describeInstant(result.at, tzOf(ctx)).human, needsStaffConfirmation: result.needsStaff || !ctx.agent.autoConfirmReservations } : { available: false, code: result.code, message: result.message, alternatives: result.alternatives?.map(a => a.human) ?? [], needsHuman: result.needsHuman ?? false };
    }
    return ok({ draft: { partySize: d.partySize ?? null, date: d.date ?? null, weekday: d.date ? WEEKDAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()] : null, time: d.time ?? null, name: name ?? null, notes: d.notes ?? null }, missing, availability }, missing.length ? `Reserva em andamento; faltam: ${missing.join(', ')}` : 'Reserva com todos os dados');
  },
});

const createSchema = z.object({ ...slotFields, name: z.string().trim().max(80).optional(), notes: z.string().trim().max(300).optional() });
export const createReservation = defineTool({
  name: 'create_reservation', kind: 'WRITE', capability: 'reservations', schema: createSchema,
  description: 'Cria a reserva de verdade (consulta o banco, reserva a mesa se houver e registra). Chame quando o cliente já pediu para reservar e você tem pessoas, dia, hora e nome. A reserva fica "PENDING" (aguardando a equipe) a menos que o restaurante confirme automaticamente. Só diga que reservou depois que esta ferramenta retornar ok.',
  async run(ctx, args) {
    const phone = verifiedPhone(ctx) ?? ctx.memory.profile.phone ?? null;
    if (!phone) return fail('PHONE_REQUIRED', 'O WhatsApp não revela o telefone deste contato. Peça um telefone de contato ao cliente e registre com update_memory (contactPhone).');
    const name = args.name ?? ctx.memory.reservation.name ?? ctx.memory.profile.name ?? ctx.customer.name;
    if (!name) return fail('NAME_REQUIRED', 'Pergunte em nome de quem fica a reserva.');
    const at = toInstant(args.date, args.time, tzOf(ctx));
    const existing = (await ctx.db.reservation.findMany({ where: { tenantId: ctx.tenantId, phone: { endsWith: last8(phone) }, status: { in: ACTIVE_RESERVATION_STATUSES }, reservedAt: { gt: new Date(at.getTime() - RESERVATION_WINDOW_MS), lt: new Date(at.getTime() + RESERVATION_WINDOW_MS) } }, take: 3 })).filter(row => samePhone(row.phone, phone));
    if (existing.length) return ok({ status: 'ALREADY_RESERVED', reservation: reservationView(ctx, existing[0]), note: 'Este cliente já tem uma reserva nesse horário. Não crie outra; se ele quiser mudar, use modify_reservation.' }, 'Já existe reserva neste horário');
    const slot = await evaluateSlot(ctx, { at, partySize: args.partySize });
    if (!slot.ok) return slotFailure(slot);
    if (ctx.dryRun) return ok({ status: 'CREATED', simulated: true, reservationId: 'simulacao', when: describeInstant(at, tzOf(ctx)).human, partySize: args.partySize, reservationStatus: 'PENDING', statusMeaning: 'simulação: nada foi gravado' }, 'Reserva simulada', { wrote: 'reservation' });
    const notes = [args.notes ?? ctx.memory.reservation.notes, 'Solicitada pelo WhatsApp (atendente de IA)'].filter(Boolean).join(' | ').slice(0, 500);
    const created = await serializable(ctx.db, async tx => {
      // Re-check inside the transaction: two customers asking for the last table at once must not both get it.
      const table = slot.needsStaff ? null : await findFreeTable(tx, { tenantId: ctx.tenantId, unitId: ctx.unitId!, partySize: args.partySize, at });
      if (!slot.needsStaff && !table) return null;
      const status = ctx.agent.autoConfirmReservations && table ? ReservationStatus.CONFIRMED : ReservationStatus.PENDING;
      return tx.reservation.create({ data: { tenantId: ctx.tenantId, unitId: ctx.unitId!, tableId: table?.id ?? null, customerName: name, phone, partySize: args.partySize, reservedAt: at, status, notes } });
    });
    if (!created) return fail('NO_TABLE', 'A última mesa foi ocupada agora há pouco. Consulte a disponibilidade de novo.');
    const when = describeInstant(at, tzOf(ctx));
    ctx.memory.reservation = { lastReservationId: created.id, lastReservationSummary: `${args.partySize} pessoa(s), ${when.human}, em nome de ${name}`, updatedAt: touch(ctx.now) };
    ctx.memory.profile.name = ctx.memory.profile.name ?? name;
    await ctx.saveMemory();
    return ok({ status: 'CREATED', ...reservationView(ctx, created), name }, `Reserva criada (${created.status})`, { wrote: 'reservation' });
  },
});

const modifySchema = z.object({ reservationId: z.string().trim().max(60).optional().describe('id da reserva (de get_my_reservations); pode omitir se o cliente só tiver uma'), partySize: slotFields.partySize.optional(), date: slotFields.date.optional(), time: slotFields.time.optional(), notes: z.string().trim().max(300).optional() });
export const modifyReservation = defineTool({
  name: 'modify_reservation', kind: 'WRITE', capability: 'reservations', schema: modifySchema,
  description: 'Altera uma reserva do próprio cliente (pessoas, dia, hora, observações), verificando a disponibilidade. Se a reserva já estava confirmada e mudar dia/hora/pessoas, volta a ficar aguardando confirmação da equipe.',
  async run(ctx, args) {
    if (!verifiedPhone(ctx)) return needPhone();
    const mine = await myReservations(ctx);
    const row = args.reservationId ? mine.find(item => item.id === args.reservationId) : mine.length === 1 ? mine[0] : undefined;
    if (!row) return fail(mine.length > 1 && !args.reservationId ? 'AMBIGUOUS' : 'NOT_FOUND', mine.length > 1 && !args.reservationId ? 'O cliente tem mais de uma reserva ativa; informe qual (reservationId).' : 'Não encontrei essa reserva neste número.');
    if (row.status === ReservationStatus.SEATED) return fail('NOT_CHANGEABLE', 'O cliente já está sentado; só a equipe pode alterar.');
    const current = describeInstant(row.reservedAt, tzOf(ctx));
    const partySize = args.partySize ?? row.partySize;
    const at = args.date || args.time ? toInstant(args.date ?? current.date, args.time ?? current.time, tzOf(ctx)) : row.reservedAt;
    const changed = partySize !== row.partySize || at.getTime() !== row.reservedAt.getTime();
    if (!changed && !args.notes) return ok({ unchanged: true, reservation: reservationView(ctx, row) }, 'Nada a alterar');
    const slot = changed ? await evaluateSlot(ctx, { at, partySize, ignoreId: row.id }) : null;
    if (slot && !slot.ok) return slotFailure(slot);
    if (ctx.dryRun) return ok({ status: 'MODIFIED', simulated: true, reservationId: row.id, when: describeInstant(at, tzOf(ctx)).human, partySize }, 'Alteração simulada', { wrote: 'modify' });
    const updated = await serializable(ctx.db, async tx => {
      const table = changed && slot && !slot.needsStaff ? await findFreeTable(tx, { tenantId: ctx.tenantId, unitId: row.unitId, partySize, at, ignoreId: row.id }) : undefined;
      if (changed && slot && !slot.needsStaff && !table) return null;
      const status = !changed ? row.status : ctx.agent.autoConfirmReservations && table ? ReservationStatus.CONFIRMED : ReservationStatus.PENDING;
      return tx.reservation.update({ where: { id: row.id }, data: { partySize, reservedAt: at, status, ...(changed ? { tableId: table?.id ?? null } : {}), ...(args.notes ? { notes: [args.notes, 'Alterada pelo WhatsApp (atendente de IA)'].join(' | ').slice(0, 500) } : {}) } });
    });
    if (!updated) return fail('NO_TABLE', 'Não há mais mesa livre para essa mudança. Consulte a disponibilidade de novo.');
    ctx.memory.reservation.lastReservationId = updated.id; ctx.memory.reservation.lastReservationSummary = `${partySize} pessoa(s), ${describeInstant(at, tzOf(ctx)).human}`;
    await ctx.saveMemory();
    return ok({ status: 'MODIFIED', ...reservationView(ctx, updated) }, `Reserva alterada (${updated.status})`, { wrote: 'modify' });
  },
});

const cancelSchema = z.object({ reservationId: z.string().trim().max(60).optional().describe('id da reserva; pode omitir se o cliente só tiver uma'), confirmation: z.string().trim().max(200).optional().describe('palavras exatas do cliente que confirmam o cancelamento (só na segunda chamada)') });
export const cancelReservation = defineTool({
  name: 'cancel_reservation', kind: 'WRITE', capability: 'reservations', schema: cancelSchema,
  description: 'Cancela uma reserva do próprio cliente. Exige confirmação: a primeira chamada só mostra o resumo para o cliente confirmar; a execução ocorre na chamada seguinte, depois que ele responder, com "confirmation".',
  async run(ctx, args) {
    if (!verifiedPhone(ctx)) return needPhone();
    const mine = await myReservations(ctx);
    const row = args.reservationId ? mine.find(item => item.id === args.reservationId) : mine.length === 1 ? mine[0] : undefined;
    if (!row) return fail(mine.length > 1 && !args.reservationId ? 'AMBIGUOUS' : 'NOT_FOUND', mine.length > 1 && !args.reservationId ? 'O cliente tem mais de uma reserva ativa; informe qual (reservationId).' : 'Não encontrei reserva ativa neste número.');
    if (row.status === ReservationStatus.SEATED) return fail('NOT_CHANGEABLE', 'O cliente já está sentado; só a equipe pode alterar.');
    const view = reservationView(ctx, row);
    const gate = requireConfirmation(ctx, { action: 'cancel_reservation', targetId: row.id, snapshot: { id: row.id, at: row.reservedAt.toISOString(), size: row.partySize }, summary: `Cancelar a reserva de ${view.partySize} pessoa(s) em ${view.when}.`, confirmation: args.confirmation });
    if (!gate.proceed) return gate.output;
    if (ctx.dryRun) return ok({ status: 'CANCELLED', simulated: true, reservationId: row.id }, 'Cancelamento simulado', { wrote: 'cancel' });
    const result = await ctx.db.reservation.updateMany({ where: { id: row.id, tenantId: ctx.tenantId, status: { in: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED] } }, data: { status: ReservationStatus.CANCELLED, notes: [row.notes, 'Cancelada pelo cliente via WhatsApp (atendente de IA)'].filter(Boolean).join(' | ').slice(0, 500) } });
    if (result.count !== 1) return fail('NOT_CHANGEABLE', 'Não foi possível cancelar: a reserva mudou de situação.');
    consumePending(ctx, 'cancel_reservation', row.id);
    if (ctx.memory.reservation.lastReservationId === row.id) ctx.memory.reservation = { updatedAt: touch(ctx.now) };
    await ctx.saveMemory();
    return ok({ status: 'CANCELLED', reservationId: row.id, was: view.when }, 'Reserva cancelada', { wrote: 'cancel' });
  },
});

export const getMyReservations = defineTool({
  name: 'get_my_reservations', kind: 'READ', capability: 'reservations', schema: z.object({}),
  description: 'Reservas ativas e futuras do cliente desta conversa (só as do telefone dele), com o status de cada uma.',
  async run(ctx) {
    if (!verifiedPhone(ctx)) return needPhone();
    const rows = await myReservations(ctx);
    return ok({ reservations: rows.map(row => reservationView(ctx, row)) }, rows.length ? `${rows.length} reserva(s) ativa(s)` : 'Nenhuma reserva ativa');
  },
});

export const reservationTools: ToolDef[] = [checkReservationAvailability, updateReservationDraft, createReservation, modifyReservation, cancelReservation, getMyReservations];
