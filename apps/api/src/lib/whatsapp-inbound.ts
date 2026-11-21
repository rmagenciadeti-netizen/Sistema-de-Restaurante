import { Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { loadBotEnv, respond, type BotResult, type BotState } from './whatsapp-bot';
import { agentGate, runConversationTurn } from './whatsapp-agent';
import { normalizeText } from './whatsapp-text';

export type InboundInput = { tenantId: string; jid: string; phone: string | null; name: string | null; text: string; externalId?: string | null };
export type InboundOutcome = { conversationId: string | null; replies: string[]; intent: string; duplicate?: boolean };

const STATE_TTL_MS = 30 * 60 * 1000;
// Legal/compliance commands stay deterministic: they must work even when no AI is available.
const CLASSIC_COMMAND = /^(parar|stop|sair|cancelar mensagens|nao quero receber( mensagens)?)$/;
// A customer who was handed to a person can ask to go back to the virtual assistant (the panel button and the handoff timer also do it).
const BACK_TO_ASSISTANT = /\b(voltar|volta|voltem|retomar|continuar|prefiro|quero|pode ser|passa|passar|chama|chamar|falar)\b.*\b(robo|bot|assistente|atendente virtual|atendimento automatico|virtual)\b|\b(robo|assistente virtual|atendente virtual|atendimento automatico)\b.*\b(voltar|volta|retomar|pode ser)\b|^(voltar|volta|retomar)( pro| para)?( robo| bot)?$/;
// Messages per customer per 10 minutes the attendant will answer; beyond that the conversation is treated as spam and the model is not called.
const AGENT_BURST_LIMIT = 40;

export async function recordOutbound(db: Prisma.TransactionClient | PrismaClient, tenantId: string, conversationId: string, body: string, source: 'BOT' | 'STAFF' | 'AUTO', externalId?: string | null) {
  await db.whatsappChatMessage.create({ data: { tenantId, conversationId, direction: 'OUT', source, body: body.slice(0, 4000), externalId: externalId ?? null } });
  await db.whatsappConversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
}

export async function findOrCreateConversation(db: PrismaClient | Prisma.TransactionClient, tenantId: string, jid: string, phone: string | null, name: string | null) {
  return db.whatsappConversation.upsert({ where: { tenantId_jid: { tenantId, jid } }, create: { tenantId, jid, phone, name }, update: { ...(name ? { name } : {}), ...(phone ? { phone } : {}) } });
}

// Stores the customer's message and, when the bot is on and no human is handling the chat, computes the replies.
// The caller sends the replies and then calls recordOutbound for each one that was really delivered.
export async function processInbound(db: PrismaClient, input: InboundInput, now = new Date()): Promise<InboundOutcome> {
  const text = input.text.trim();
  if (!text) return { conversationId: null, replies: [], intent: 'empty' };
  if (input.externalId && await db.whatsappChatMessage.findFirst({ where: { tenantId: input.tenantId, externalId: input.externalId }, select: { id: true } })) return { conversationId: null, replies: [], intent: 'duplicate', duplicate: true };

  const conversation = await findOrCreateConversation(db, input.tenantId, input.jid, input.phone, input.name);
  const previousMessageAt = conversation.lastMessageAt;
  const inboundRow = await db.whatsappChatMessage.create({ data: { tenantId: input.tenantId, conversationId: conversation.id, direction: 'IN', source: 'CUSTOMER', body: text.slice(0, 4000), externalId: input.externalId ?? null } });
  await db.whatsappConversation.update({ where: { id: conversation.id }, data: { unread: { increment: 1 }, lastMessageAt: now } });

  const settings = await loadSettings(db, input.tenantId);
  if (!settings.whatsapp.botEnabled) return { conversationId: conversation.id, replies: [], intent: 'bot_disabled' };

  const normalized = normalizeText(text);
  let returnedFromHandoff = false;
  if (conversation.handoff) {
    const active = !conversation.handoffUntil || conversation.handoffUntil > now;
    if (active && !(settings.whatsapp.agent.enabled && BACK_TO_ASSISTANT.test(normalized))) return { conversationId: conversation.id, replies: [], intent: 'handoff_active' };
    returnedFromHandoff = active;
    await db.whatsappConversation.update({ where: { id: conversation.id }, data: { handoff: false, handoffUntil: null } });
  }

  const wantsBack = /^(voltar|iniciar|retomar)$/i.test(text);
  if (conversation.optOut && !wantsBack) return { conversationId: conversation.id, replies: [], intent: 'opted_out' };

  const env = await loadBotEnv(db, input.tenantId, now);
  const greetDue = !conversation.lastGreetingAt || now.getTime() - conversation.lastGreetingAt.getTime() > settings.whatsapp.greetingCooldownHours * 3_600_000;

  // The AI attendant leads the conversation when it is on and available; otherwise (or if it fails) the classic keyword bot below answers.
  const classicCommand = CLASSIC_COMMAND.test(normalized) || (conversation.optOut && /^(voltar|iniciar|retomar)$/.test(normalized));
  if (!classicCommand && settings.whatsapp.agent.enabled) {
    const gate = await agentGate(env);
    if (gate.available) {
      const recent = await db.whatsappChatMessage.count({ where: { conversationId: conversation.id, direction: 'IN', createdAt: { gte: new Date(now.getTime() - 10 * 60_000) } } });
      if (recent > AGENT_BURST_LIMIT) return { conversationId: conversation.id, replies: [], intent: 'rate_limited' };
      const turn = await runConversationTurn(db, env, conversation, { id: inboundRow.id, text: text.slice(0, 1000) }, { now, greetingDue: greetDue, returnedFromHandoff });
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
        return { conversationId: conversation.id, replies: turn.replies, intent: turn.handoff ? 'agent_handoff' : 'agent' };
      }
      console.warn(`[agent] unavailable for this message (${turn.code}); the classic bot answers`);
    }
  }

  const stale = now.getTime() - previousMessageAt.getTime() > STATE_TTL_MS;
  const state = !stale && conversation.stateData ? conversation.stateData as unknown as BotState : null;
  const result: BotResult = await respond(db, env, { text, phone: input.phone, name: input.name ?? conversation.name, state, greetDue }, { now });

  await db.whatsappConversation.update({
    where: { id: conversation.id },
    data: {
      stateData: result.state ? result.state as unknown as Prisma.InputJsonObject : Prisma.JsonNull,
      ...(result.handoff ? { handoff: true, handoffUntil: new Date(now.getTime() + settings.whatsapp.handoffMinutes * 60_000) } : {}),
      ...(result.optOut ? { optOut: true } : {}), ...(result.optIn ? { optOut: false } : {}),
      ...(result.greeted ? { lastGreetingAt: now } : {}),
    },
  });
  return { conversationId: conversation.id, replies: result.replies, intent: result.intent };
}
