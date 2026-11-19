import type { PaymentMethod } from '@prisma/client';

// Common contract every TEF provider adapter implements. The sales flow only talks to this interface, so a new provider never changes the core.
export type TefConfigField = { key: string; label: string; secret?: boolean; required?: boolean; hint?: string; options?: string[] };
export type TefCapabilities = { methods: PaymentMethod[]; installments: boolean; query: boolean; cancel: boolean; pix: boolean };
export type TefConfigView = {
  environment: 'HOMOLOGATION' | 'PRODUCTION'; establishmentCnpj: string | null; merchantCode: string | null; logicalNumber: string | null; terminalId: string | null; cashRegisterId: string | null; pinpad: string | null;
  connection: Record<string, unknown>; credentials: Record<string, string>;
};
export type TefStartRequest = { reference: string; method: PaymentMethod; amount: string; installments: number; description: string; hints?: Record<string, string> };
// APPROVED is only accepted by the core after validation; anything else never creates a payment.
export type TefOutcome = 'APPROVED' | 'DENIED' | 'PENDING' | 'TIMEOUT' | 'UNKNOWN' | 'NOT_FOUND' | 'CANCELLED' | 'REVERSED';
export type TefResponse = {
  outcome: TefOutcome; providerRef?: string; amount?: string; nsu?: string; authorizationCode?: string; cardBrand?: string; acquirerCnpj?: string; pixEndToEnd?: string; terminalId?: string;
  responseCode?: string; message?: string;
};
export type TefReversal = { ok: boolean; reversalRef?: string; message?: string };

export interface TefAdapter {
  readonly name: string;
  readonly label: string;
  // Simulators are never registered in production and can never be marked as homologated.
  readonly simulated: boolean;
  readonly fields: TefConfigField[];
  readonly capabilities: TefCapabilities;
  testConnection(config: TefConfigView): Promise<{ ok: boolean; message: string }>;
  start(request: TefStartRequest, config: TefConfigView): Promise<TefResponse>;
  // Must be side-effect free: it only asks the provider for the state of `reference`.
  query?(reference: string, config: TefConfigView): Promise<TefResponse>;
  cancel?(transaction: { reference: string; providerRef: string | null; nsu: string | null; amount: string }, config: TefConfigView): Promise<TefReversal>;
}

export class TefTimeoutError extends Error {}

export class TefAdapterRegistry {
  private readonly adapters = new Map<string, TefAdapter>();
  register(adapter: TefAdapter) {
    if (adapter.simulated && process.env.NODE_ENV === 'production') throw new Error('Simulated TEF adapters cannot be registered in production');
    this.adapters.set(adapter.name, adapter);
  }
  get(name: string) { return this.adapters.get(name); }
  all() { return [...this.adapters.values()]; }
  clear() { this.adapters.clear(); }
}

// Deployments register certified adapters at startup (src/providers.config.ts). Nothing is registered by default.
export const tefAdapters = new TefAdapterRegistry();
