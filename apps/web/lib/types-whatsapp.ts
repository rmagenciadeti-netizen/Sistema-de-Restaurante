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
