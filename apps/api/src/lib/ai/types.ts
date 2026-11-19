import type { UserRole } from '@prisma/client';

// Authenticated context built ONLY from the verified session (never from the question or the request body's tenant).
export type AiContext = { tenantId: string; userId: string; role: UserRole; boundUnitId: string | null; unitId: string | null };
export type Period = { from: Date; to: Date };
export type Alert = { severity: 'critical' | 'warning' | 'info'; message: string };
// Every figure comes from backend queries. `kind` separates recorded facts from estimates/projections.
export type ToolResult = {
  tool: string; title: string; period: { from: string; to: string }; unit: string | null; source: string; kind: 'FACT' | 'ESTIMATE' | 'MIXED';
  data: Record<string, unknown>; highlights: string[]; alerts: Alert[]; limitations: string[];
  // Compact aggregate view that may be sent to an external model (no personal data).
  llmFacts: Record<string, unknown>;
};
export type DataPart = 'orders' | 'finance' | 'ingredients' | 'stockMovements' | 'products' | 'purchases' | 'customers' | 'delivery' | 'items' | 'settings';
export type ToolDef = { name: string; description: string; parts: DataPart[]; run(ctx: AiContext, period: Period): Promise<ToolResult> };
export type DomainKey = 'finance' | 'stock' | 'profit' | 'sales' | 'purchasing' | 'customers' | 'delivery' | 'production' | 'waste' | 'management';
export type DomainDef = {
  key: DomainKey; name: string; icon: string; description: string; roles: UserRole[];
  // Commercial module that licenses it (see MODULE_CATALOG / ROUTE_MODULES).
  module: 'intelligence' | 'profit';
  keywords: RegExp; instructions: string; tools: ToolDef[]; panel: string[];
};
export class AiAccessError extends Error { constructor(message: string, readonly status = 403, readonly code = 'AI_FORBIDDEN') { super(message); } }
