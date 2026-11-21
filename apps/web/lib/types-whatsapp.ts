import type { WhatsappMessage } from './api';

export type WhatsappSessionStatus = 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'LOGGED_OUT' | 'ERROR';

export type WhatsappSession = {
  status: WhatsappSessionStatus;
  desired: 'CONNECTED' | 'DISCONNECTED';
  qr: string | null;
  phone: string | null;
  pushName: string | null;
  lastError: string | null;
  connectedAt: string | null;
  managerOnline: boolean;
  cloudConfigured: boolean;
  aiConfigured: boolean;
};

export type WhatsappStats = { conversations: number; inboundToday: number; botRepliesToday: number; handoffOpen: number; unanswered: number; outboundQueued: number };

export type WhatsappConversation = { id: string; phone: string | null; name: string | null; lastMessageAt: string; lastMessage: string | null; unread: number; handoff: boolean; optOut: boolean };
export type ConversationFilter = 'all' | 'handoff' | 'unread';
export type ChatMessage = { id: string; direction: 'IN' | 'OUT'; source: 'CUSTOMER' | 'BOT' | 'STAFF' | 'AUTO'; body: string; createdAt: string };

export type AutoMessage = { key: string; title: string; description: string; enabled: boolean; body: string; defaultBody: string; variables: string[] };

export type KnowledgeEntry = { id: string; title: string; keywords: string[]; answer: string; active: boolean; hits: number };
export type KnowledgeInput = { title: string; keywords: string[]; answer: string; active: boolean };
export type UnansweredQuestion = { id: string; text: string; count: number; lastAskedAt: string };

export type SimulateResponse = { replies: string[]; state: unknown; intent: string; handoff: boolean };

export type OutboxItem = WhatsappMessage & { payload?: { text?: string } | null };

export type AgentStatus = {
  enabled: boolean; botEnabled: boolean; available: boolean; reason: string | null; mode: 'AI' | 'CLASSIC' | 'OFF';
  provider: string | null; model: string | null; providerConfigured: boolean; toolCalling: boolean; consent: boolean; externalEnabled: boolean;
  usage: { callsToday: number; dailyLimit: number }; operationsToday: number; handoffOpen: number;
};
export type AgentAction = { id: string; tool: string; kind: 'READ' | 'MEMORY' | 'WRITE' | 'PROPOSAL'; ok: boolean; summary: string | null; at: string; durationMs: number; conversationId: string; customer: string | null };
export type AgentSession = { memory?: unknown; history: { role: 'user' | 'assistant'; content: string }[] };
export type AgentSimulateResponse =
  | { available: false; reason: string }
  | { available: true; ok: boolean; replies: string[]; reason: string | null; handoff: { reason: string; summary: string } | null; actions: { tool: string; kind: string; ok: boolean; summary: string }[]; session: AgentSession; model: string | null };
export type ConversationAgentInfo = {
  profile: { name: string | null; addresses: string[]; preferences: string[] }; facts: string[];
  reservation: { partySize?: number; date?: string; time?: string; name?: string; lastReservationSummary?: string };
  order: { items: { name: string; quantity: number; options: string[] }[]; fulfillment: string | null; lastOrderNumber: string | null };
  delivery: { address?: string; zoneName?: string; neighborhood?: string }; payment: { methodName?: string };
  pending: { action: string; summary: string; expiresAt: string }[]; handoff: { reason: string; summary: string; at: string } | null; summary: string | null; turns: number;
  actions: { id: string; tool: string; kind: string; ok: boolean; summary: string | null; createdAt: string }[];
};
