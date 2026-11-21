import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { TenantSettingsData } from '../settings';
import type { BotEnv } from '../whatsapp-bot';
import type { AgentMemory } from './memory';

export type AgentSettings = TenantSettingsData['whatsapp']['agent'];
// READ: consults the restaurant. MEMORY: only changes the conversation memory. WRITE: changes real data (reservations, orders) and is logged with a dedupe key.
export type ToolKind = 'READ' | 'MEMORY' | 'WRITE';
export type Capability = 'reservations' | 'orders' | 'orderChanges';
export type ToolOutput = {
  ok: boolean; data?: unknown; error?: { code: string; message: string }; summary: string;
  handoff?: { reason: string; summary: string }; optOut?: boolean;
  // What the backend really did (feeds the "never claim an operation that did not happen" check).
  wrote?: 'reservation' | 'order' | 'cancel' | 'modify'; duplicate?: boolean;
  // The tool only asked the customer to confirm: nothing was executed yet.
  proposal?: boolean;
};
// Everything a tool may use. Built by the backend from the verified conversation; the model can never choose the tenant, the customer or the conversation.
export type ToolContext = {
  db: PrismaClient; env: BotEnv; agent: AgentSettings; now: Date; dryRun: boolean;
  tenantId: string; unitId: string | null; conversationId: string; messageId: string; inboundText: string;
  customer: { phone: string | null; name: string | null };
  memory: AgentMemory; saveMemory(): Promise<void>;
};
export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string; description: string; kind: ToolKind; capability?: Capability; schema: S;
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolOutput>;
};

// Declares a tool with typed arguments (inferred from its zod schema) and stores it in the registry's common shape.
export const defineTool = <S extends z.ZodType>(tool: ToolDef<S>): ToolDef => tool as unknown as ToolDef;
