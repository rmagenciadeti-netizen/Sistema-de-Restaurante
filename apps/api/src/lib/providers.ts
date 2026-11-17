import type { IncomingHttpHeaders } from 'node:http';
import type { PaymentMethod } from '@prisma/client';

export type ChargeRequest = { chargeId: string; method: PaymentMethod; amount: string; description: string };
export type ChargeResult = { externalRef: string; qrPayload?: string };
export type WebhookEvent = { externalRef: string; status: 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED' };
export type EmailMessage = { to: string; subject: string; text: string; html: string };
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

// Implemented by a concrete acquirer/PIX gateway adapter. parseWebhook MUST verify the provider's signature and return null for anything unauthenticated.
export interface PaymentProvider {
  readonly name: string;
  createCharge(request: ChargeRequest): Promise<ChargeResult>;
  parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): WebhookEvent | null;
}

export type FiscalOrder = {
  orderId: string; code: string; total: string; issuedAt: Date;
  customer: { name: string | null; document: string | null };
  items: Array<{ name: string; quantity: number; unitPrice: string; total: string }>;
};
export type FiscalEmission = { status: 'AUTHORIZED' | 'REJECTED'; number?: string; accessKey?: string; documentUrl?: string; error?: string };

// Implemented by a certified tax-document provider (NFC-e/NF-e). Fiscal rules, certificates and homologation belong to the provider.
export interface FiscalProvider {
  readonly name: string;
  emit(order: FiscalOrder, kind: 'NFCE' | 'NFE'): Promise<FiscalEmission>;
  cancel(document: { number: string | null; accessKey: string | null }, reason: string): Promise<{ cancelled: boolean; error?: string }>;
}

export class ProviderRegistry<T extends { name: string }> {
  private readonly providers = new Map<string, T>();
  register(provider: T) { this.providers.set(provider.name, provider); }
  get(name: string) { return this.providers.get(name); }
  names() { return [...this.providers.keys()]; }
  clear() { this.providers.clear(); }
}

// Deployments register concrete adapters at startup (see src/providers.config.ts). Nothing is registered by default.
export const paymentProviders = new ProviderRegistry<PaymentProvider>();
export const fiscalProviders = new ProviderRegistry<FiscalProvider>();
export const emailProviders = new ProviderRegistry<EmailProvider>();
