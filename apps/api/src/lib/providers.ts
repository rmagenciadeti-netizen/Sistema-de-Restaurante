import type { IncomingHttpHeaders } from 'node:http';
import type { PaymentMethod } from '@prisma/client';
import type { FiscalIssuer } from './fiscal-config';

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

// Tax parameters come from the product's tax rule (Fiscal / Tributos), optionally overridden per item on the document; the provider applies them.
export type FiscalItemTax = {
  ncm: string | null; cest: string | null; origin: number; cfop: string | null;
  icmsCst: string | null; icmsRate: string | null; icmsReduction: string | null;
  pisCst: string | null; pisRate: string | null; cofinsCst: string | null; cofinsRate: string | null;
  icmsStMva?: string | null; icmsStRate?: string | null; icmsStReduction?: string | null; fcpRate?: string | null; fcpStRate?: string | null; cBenef?: string | null;
  ipiCst?: string | null; ipiEnquadramento?: string | null; ipiRate?: string | null;
  ibsCbsCst?: string | null; cClassTrib?: string | null; ibsUfRate?: string | null; ibsMunRate?: string | null; cbsRate?: string | null; isRate?: string | null;
};
export type FiscalRecipient = {
  name: string | null; document: string | null; email?: string | null; stateRegistration?: string | null; contributorIndicator?: '1' | '2' | '9';
  address?: { street: string; number: string; complement?: string; district: string; city: string; cityIbge: string; uf: string; cep: string } | null;
};
export type FiscalOrder = {
  orderId: string; code: string; total: string; issuedAt: Date;
  // Series and sequential number reserved from the tenant's numbering (GET/PUT /fiscal/numbering).
  series: string; number: string;
  customer: FiscalRecipient;
  items: Array<{ name: string; quantity: number; unitPrice: string; total: string; tax: FiscalItemTax; code?: string; gtin?: string | null; unit?: string }>;
  // Idempotency key: the FiscalDocument id. Retrying with the same ref must never create a second document at the provider.
  ref?: string;
  nature?: string; finality?: '1' | '2' | '3' | '4'; freight?: string; otherExpenses?: string; discount?: string; additionalInfo?: string;
  // `integrated` payments carry the real data returned by the TEF/PIX provider (never filled in by hand).
  payments?: Array<{ method: string; amount: string; integrated?: boolean; acquirerCnpj?: string | null; cardBrand?: string | null; authorizationCode?: string | null; pixEndToEnd?: string | null }>;
  // tpNF (0 entrada, 1 saída) and idDest (1 interna, 2 interestadual, 3 exterior), resolved from the operation rule.
  operationType?: '0' | '1'; destination?: '1' | '2' | '3';
  // Off-line contingency document already signed and printed: must be transmitted exactly as is.
  signedXml?: string;
};
export type FiscalResultStatus = 'AUTHORIZED' | 'REJECTED' | 'PROCESSING' | 'DENIED' | 'CANCELLED' | 'NOT_FOUND';
// PROCESSING = sent without an official answer yet; it is consulted before any retry so a number is never issued twice.
export type FiscalEmission = { status: FiscalResultStatus; number?: string; accessKey?: string; documentUrl?: string; error?: string; protocol?: string; statusCode?: string; xml?: string; contingency?: boolean };
export type FiscalEventResult = { status: 'REGISTERED' | 'REJECTED'; protocol?: string; xml?: string; error?: string };
export type FiscalContext = {
  environment: 'HOMOLOGATION' | 'PRODUCTION';
  issuer: FiscalIssuer; crt: number;
  token: string | null; csc: { id: string; token: string } | null; certificate: { pfxBase64: string; password: string } | null;
  // True while the company is in a declared contingency period: the provider should use the applicable offline modality.
  contingency: boolean;
};
export type FiscalDocumentRef = { ref: string; kind: 'NFCE' | 'NFE'; number: string | null; series: string | null; accessKey: string | null; protocol?: string | null; xml?: string | null; order?: FiscalOrder | null };
export type FiscalInutilization = { kind: 'NFCE' | 'NFE'; series: string; numberFrom: number; numberTo: number; year: number; justification: string };

// Implemented by a certified tax-document provider (NFC-e/NF-e) or a direct SEFAZ adapter. Optional methods unlock the matching screens.
export interface FiscalProvider {
  readonly name: string;
  emit(order: FiscalOrder, kind: 'NFCE' | 'NFE', context?: FiscalContext): Promise<FiscalEmission>;
  cancel(document: { number: string | null; accessKey: string | null; ref?: string; kind?: 'NFCE' | 'NFE'; protocol?: string | null }, reason: string, context?: FiscalContext): Promise<{ cancelled: boolean; error?: string; protocol?: string; xml?: string }>;
  consult?(document: FiscalDocumentRef, context: FiscalContext): Promise<FiscalEmission>;
  correct?(document: FiscalDocumentRef, correction: string, sequence: number, context: FiscalContext): Promise<FiscalEventResult>;
  inutilize?(request: FiscalInutilization, context: FiscalContext): Promise<FiscalEventResult>;
  testConnection?(context: FiscalContext): Promise<{ ok: boolean; message: string }>;
}

// Thrown when the request may have reached SEFAZ but no answer came back: the access key/signed XML are kept so the document can be consulted.
export class FiscalTransportError extends Error {
  constructor(message: string, readonly accessKey?: string, readonly xml?: string) { super(message); }
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
