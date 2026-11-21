import { Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { loadBotEnv } from './whatsapp-bot';
import { botStateSchema, respond, type BotState } from './whatsapp-router';
import { agentGate, runConversationTurn } from './whatsapp-agent';
import { normalizeText } from './whatsapp-text';

export type InboundInput = { tenantId: string; jid: string; phone: string | null; name: string | null; text: string; externalId?: string | null };
export type InboundOutcome = { conversationId: string | null; replies: string[]; intent: string; duplicate?: boolean };
// What arrival leaves behind: the stored customer message, ready to be answered later (and in order).
export type StoredInbound = { conversationId: string; rowId: string; createdAt: Date; text: string };

// Legal/compliance commands stay deterministic: they must work even when no AI is available.
const CLASSIC_COMMAND = /^(parar|stop|sair|cancelar mensagens|nao quero receber( mensagens)?)$/;
// A customer who was handed to a person can ask to go back to the virtual assistant (the panel button and the handoff timer also do it).
const BACK_TO_ASSISTANT = /\b(voltar|volta|voltem|retomar|continuar|prefiro|quero|pode ser|passa|passar|chama|chamar|falar)\b.*\b(robo|bot|assistente|atendente virtual|atendimento automatico|virtual)\b|\b(robo|assistente virtual|atendente virtual|atendimento automatico)\b.*\b(voltar|volta|retomar|pode ser)\b|^(voltar|volta|retomar)( pro| para)?( robo| bot)?$/;
// Messages per customer per 10 minutes the attendant will answer; beyond that the conversation is treated as spam and the model is not called.
const AGENT_BURST_LIMIT = 40;
// Messages sent one after the other (people type in pieces) are answered together, once; this is how far apart two pieces may be.
const BURST_WINDOW_MS = 90_000;

export async function recordOutbound(db: Prisma.TransactionClient | PrismaClient, tenantId: string, conversationId: string, body: string, source: 'BOT' | 'STAFF' | 'AUTO', externalId?: string | null) {
  await db.whatsappChatMessage.create({ data: { tenantId, conversationId, direction: 'OUT', source, body: body.slice(0, 4000), externalId: externalId ?? null } });
  await db.whatsappConversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
}

export async function findOrCreateConversation(db: PrismaClient | Prisma.TransactionClient, tenantId: string, jid: string, phone: string | null, name: string | null) {
  return db.whatsappConversation.upsert({ where: { tenantId_jid: { tenantId, jid } }, create: { tenantId, jid, phone, name }, update: { ...(name ? { name } : {}), ...(phone ? { phone } : {}) } });
}

// Step 1, the moment the message arrives: keep it. Returns null for an empty message or one that was already received (a re-delivery never gets a second answer).
// Callers must store the messages of one customer one at a time, in the order they arrived.
export async function storeInbound(db: PrismaClient, input: InboundInput, now = new Date()): Promise<StoredInbound | null> {
  const text = input.text.trim();
  if (!text) return null;
  if (input.externalId && await db.whatsappChatMessage.findFirst({ where: { tenantId: input.tenantId, externalId: input.externalId }, select: { id: true } })) return null;
  const conversation = await findOrCreateConversation(db, input.tenantId, input.jid, input.phone, input.name);
  // Strictly increasing within the conversation, so "which message is the newest" never depends on a tie in the clock.
  const latest = await db.whatsappChatMessage.findFirst({ where: { conversationId: conversation.id, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
  const row = await db.whatsappChatMessage.create({ data: { tenantId: input.tenantId, conversationId: conversation.id, direction: 'IN', source: 'CUSTOMER', body: text.slice(0, 4000), externalId: input.externalId ?? null, createdAt } });
  await db.whatsappConversation.update({ where: { id: conversation.id }, data: { unread: { increment: 1 }, lastMessageAt: now } });
  return { conversationId: conversation.id, rowId: row.id, createdAt, text: text.slice(0, 4000) };
}

// What the customer said in the last burst of messages that nobody has answered yet.
async function unansweredText(db: PrismaClient, conversationId: string, stored: StoredInbound): Promise<string> {
  const lastReply = await db.whatsappChatMessage.findFirst({ where: { conversationId, direction: 'OUT', source: { in: ['BOT', 'STAFF'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const since = Math.max(lastReply?.createdAt.getTime() ?? 0, stored.createdAt.getTime() - BURST_WINDOW_MS);
  const rows = await db.whatsappChatMessage.findMany({ where: { conversationId, direction: 'IN', createdAt: { gt: new Date(since), lte: stored.createdAt } }, orderBy: { createdAt: 'asc' }, take: 8, select: { body: true } });
  return (rows.length ? rows.map(row => row.body).join('\n') : stored.text).slice(0, 1000);
}

const readState = (raw: unknown): BotState => { const parsed = botStateSchema.safeParse(raw ?? null); return parsed.success ? parsed.data : null; };

// Step 2, when the customer's turn comes: compute the replies. The caller sends them and then calls recordOutbound for each one that was really delivered.
// Everything is read again here (the conversation may have changed while earlier messages were being answered). With `batch` (the live session path, which records
// every reply it sends) the customer's last burst of unanswered messages is answered as one.
export async function answerInbound(db: PrismaClient, input: InboundInput, stored: StoredInbound, now = new Date(), options: { batch?: boolean } = {}): Promise<InboundOutcome> {
  const conversation = await db.whatsappConversation.findUnique({ where: { id: stored.conversationId } });
  if (!conversation) return { conversationId: null, replies: [], intent: 'gone' };
  const base = { conversationId: conversation.id };
  // A newer message is already waiting: it is answered together with this one, in the context of both. A burst gets one coherent answer, not three.
  if (await db.whatsappChatMessage.findFirst({ where: { conversationId: conversation.id, direction: 'IN', createdAt: { gt: stored.createdAt } }, select: { id: true } })) return { ...base, replies: [], intent: 'batched' };

  const settings = await loadSettings(db, input.tenantId);
  if (!settings.whatsapp.botEnabled) return { ...base, replies: [], intent: 'bot_disabled' };

  const text = options.batch ? await unansweredText(db, conversation.id, stored) : stored.text.slice(0, 1000);
  const normalized = normalizeText(text);
  let returnedFromHandoff = false;
  if (conversation.handoff) {
    const active = !conversation.handoffUntil || conversation.handoffUntil > now;
    if (active && !(settings.whatsapp.agent.enabled && BACK_TO_ASSISTANT.test(normalized))) return { ...base, replies: [], intent: 'handoff_active' };
    returnedFromHandoff = active;
    await db.whatsappConversation.update({ where: { id: conversation.id }, data: { handoff: false, handoffUntil: null } });
  }

  const wantsBack = /^(voltar|iniciar|retomar)$/i.test(text);
  if (conversation.optOut && !wantsBack) return { ...base, replies: [], intent: 'opted_out' };

  const env = await loadBotEnv(db, input.tenantId, now);
  const greetDue = !conversation.lastGreetingAt || now.getTime() - conversation.lastGreetingAt.getTime() > settings.whatsapp.greetingCooldownHours * 3_600_000;

  // The AI attendant leads the conversation when it is on and available; otherwise (or if it fails) the classic bot below answers.
  const classicCommand = CLASSIC_COMMAND.test(normalized) || (conversation.optOut && /^(voltar|iniciar|retomar)$/.test(normalized));
  if (!classicCommand && settings.whatsapp.agent.enabled) {
    const gate = await agentGate(env);
    if (gate.available) {
      const recent = await db.whatsappChatMessage.count({ where: { conversationId: conversation.id, direction: 'IN', createdAt: { gte: new Date(now.getTime() - 10 * 60_000) } } });
      if (recent > AGENT_BURST_LIMIT) return { ...base, replies: [], intent: 'rate_limited' };
      const turn = await runConversationTurn(db, env, conversation, { id: stored.rowId, text }, { now, greetingDue: greetDue, returnedFromHandoff });
      if (turn.ok) {
        await db.whatsappConversation.update({
          where: { id: conversation.id },
          data: {
            stateData: Prisma.JsonNull,
            ...(turn.handoff ? { handoff: true, handoffUntil: new Date(now.getTime() + settings.whatsapp.handoffMinutes * 60_000) } : {}),
            ...(turn.optOut === true ? { optOut: true } : {}), ...(turn.optOut === false ? { optOut: false } : {}),
            ...(greetDue ? { lastGreetingAt: now } : {}),
          },
        });
        return { ...base, replies: turn.replies, intent: turn.handoff ? 'agent_handoff' : 'agent' };
      }
      console.warn(`[agent] unavailable for this message (${turn.code}); the classic bot answers`);
    }
  }

  const result = await respond(db, env, { text, phone: input.phone, name: input.name ?? conversation.name, state: readState(conversation.stateData), greetDue }, { now });
  await db.whatsappConversation.update({
    where: { id: conversation.id },
    data: {
      stateData: result.state ? result.state as unknown as Prisma.InputJsonObject : Prisma.JsonNull,
      ...(result.handoff ? { handoff: true, handoffUntil: new Date(now.getTime() + settings.whatsapp.handoffMinutes * 60_000) } : {}),
      ...(result.optOut ? { optOut: true } : {}), ...(result.optIn ? { optOut: false } : {}),
      ...(result.greeted ? { lastGreetingAt: now } : {}),
    },
  });
  return { ...base, replies: result.replies, intent: result.intent };
}

// Store and answer in one go: for callers that handle one message at a time (the tests, the Cloud API webhook path).
export async function processInbound(db: PrismaClient, input: InboundInput, now = new Date()): Promise<InboundOutcome> {
  if (!input.text.trim()) return { conversationId: null, replies: [], intent: 'empty' };
  const stored = await storeInbound(db, input, now);
  if (!stored) return { conversationId: null, replies: [], intent: 'duplicate', duplicate: true };
  return answerInbound(db, input, stored, now);
}
