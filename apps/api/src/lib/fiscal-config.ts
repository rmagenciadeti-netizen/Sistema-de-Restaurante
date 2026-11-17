import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { FiscalEnvironment, type FiscalSettings, type Prisma } from '@prisma/client';
import { z } from 'zod';
import type { FiscalContext } from './providers';

// ---- Secrets (provider token, CSC, A1 certificate and its password) ----
function encryptionKey() {
  const configured = process.env.FISCAL_ENCRYPTION_KEY;
  if (!configured) throw new FiscalConfigError('Configure FISCAL_ENCRYPTION_KEY no servidor para guardar certificados e tokens fiscais.', 503);
  const key = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new FiscalConfigError('FISCAL_ENCRYPTION_KEY deve ter 32 bytes (hex ou base64).', 503);
  return key;
}
export class FiscalConfigError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

export function sealSecret(value: string | Buffer) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
export function openSecret(value: string): Buffer {
  const [version, iv, tag, encrypted] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new FiscalConfigError('Segredo fiscal corrompido; cadastre-o novamente.', 500);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
}

// ---- A1 certificate inspection (built-in TLS: validates the password and reads holder/validity without extra libraries) ----
export type CertificateInfo = { subject: string; cnpj: string | null; validFrom: Date; validTo: Date };
export function inspectCertificate(pfx: Buffer, password: string): CertificateInfo {
  let der: Buffer | undefined;
  try {
    const context = createSecureContext({ pfx, passphrase: password }) as unknown as { context: { getCertificate(): Buffer | undefined } };
    der = context.context.getCertificate();
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    throw new FiscalConfigError(/mac verify|bad decrypt|password/i.test(text) ? 'Senha do certificado incorreta.' : 'Arquivo de certificado inválido (envie o .pfx/.p12 do certificado A1).');
  }
  if (!der) throw new FiscalConfigError('O arquivo não contém um certificado.');
  const cert = new X509Certificate(der);
  // ICP-Brasil e-CNPJ: "CN=RAZAO SOCIAL:CNPJ"; fall back to any 14-digit run in the subject.
  const cnpj = /:(\d{14})(?:\D|$)/.exec(cert.subject)?.[1] ?? /\b(\d{14})\b/.exec(cert.subject)?.[1] ?? null;
  return { subject: cert.subject.replace(/\n/g, ', '), cnpj, validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo) };
}

// ---- Settings shape ----
const digits = (min: number, max: number) => z.string().trim().transform(value => value.replace(/\D/g, '')).refine(value => value === '' || (value.length >= min && value.length <= max), `Informe de ${min} a ${max} dígitos`);
const text = (max: number, fallback = '') => z.string().trim().max(max).default(fallback);
export const issuerSchema = z.object({
  legalName: text(120), tradeName: text(120), cnpj: digits(14, 14).default(''), stateRegistration: z.string().trim().max(20).default(''), municipalRegistration: text(20),
  cnae: digits(7, 7).default(''), taxRegime: z.enum(['SIMPLES_NACIONAL', 'SIMPLES_EXCESSO', 'NORMAL', 'MEI']).default('SIMPLES_NACIONAL'),
  street: text(120), number: text(20), complement: text(60), district: text(60), city: text(60), cityIbge: digits(7, 7).default(''), uf: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, 'UF inválida').default(''),
  cep: digits(8, 8).default(''), country: text(60, 'Brasil'), countryCode: digits(4, 4).default('1058'), phone: text(20), contributorIndicator: z.enum(['1', '2', '9']).default('1'),
});
export type FiscalIssuer = z.infer<typeof issuerSchema>;
// CRT derives from the tax regime (1 Simples, 2 Simples com excesso de sublimite, 3 Regime normal, 4 MEI).
export const crtOf = (regime: FiscalIssuer['taxRegime']) => ({ SIMPLES_NACIONAL: 1, SIMPLES_EXCESSO: 2, NORMAL: 3, MEI: 4 })[regime];
export const modelSchema = z.object({
  nature: z.string().trim().min(2).max(60).default('Venda de mercadoria'), emissionType: z.enum(['NORMAL', 'CONTINGENCY_OFFLINE', 'EPEC', 'FS_DA']).default('NORMAL'),
  finality: z.enum(['1', '2', '3', '4']).default('1'), defaultCfop: z.string().trim().regex(/^(\d{4})?$/, 'CFOP deve ter 4 dígitos').default(''), additionalInfo: z.string().trim().max(2000).default(''),
});
export type FiscalModelConfig = z.infer<typeof modelSchema>;
export const PDV_MODES = ['FISCAL', 'NON_FISCAL', 'ASK'] as const;
export type PdvMode = typeof PDV_MODES[number];

export function issuerOf(settings: Pick<FiscalSettings, 'issuer'> | null): FiscalIssuer { return issuerSchema.parse(settings?.issuer ?? {}); }
export function modelOf(settings: Pick<FiscalSettings, 'nfe' | 'nfce'> | null, kind: 'NFE' | 'NFCE'): FiscalModelConfig { return modelSchema.parse((kind === 'NFE' ? settings?.nfe : settings?.nfce) ?? {}); }

// Tenants configured before the fiscal settings existed keep emitting as before (production through the provider's own credentials).
export const environmentOf = (settings: Pick<FiscalSettings, 'environment'> | null) => settings?.environment ?? FiscalEnvironment.PRODUCTION;

export async function loadFiscalSettings(db: Pick<Prisma.TransactionClient, 'fiscalSettings'>, tenantId: string) {
  return db.fiscalSettings.findUnique({ where: { tenantId } });
}

const CERT_ALERT_DAYS = 30;
export function certificateStatus(settings: Pick<FiscalSettings, 'certValidTo' | 'certPfxEnc'> | null, now = new Date()) {
  if (!settings?.certPfxEnc || !settings.certValidTo) return { state: 'MISSING' as const, daysLeft: null };
  const daysLeft = Math.floor((settings.certValidTo.getTime() - now.getTime()) / 86_400_000);
  return { state: daysLeft < 0 ? 'EXPIRED' as const : daysLeft <= CERT_ALERT_DAYS ? 'EXPIRING' as const : 'VALID' as const, daysLeft };
}

// What is still missing before documents of `kind` can be emitted. Empty list = ready.
export function readinessProblems(settings: FiscalSettings | null, kind: 'NFE' | 'NFCE', registeredProviders: string[]): string[] {
  if (!settings) return registeredProviders.length > 0 ? [] : ['Nenhum provedor fiscal configurado.'];
  const problems: string[] = []; const issuer = issuerOf(settings);
  if (!settings.provider || !registeredProviders.includes(settings.provider)) problems.push('Selecione um provedor fiscal disponível.');
  if (issuer.cnpj.length !== 14) problems.push('Informe o CNPJ do emitente.');
  if (!issuer.legalName) problems.push('Informe a razão social do emitente.');
  if (!issuer.stateRegistration) problems.push('Informe a inscrição estadual.');
  if (!issuer.uf || issuer.cityIbge.length !== 7) problems.push('Informe UF e código IBGE do município.');
  const cert = certificateStatus(settings);
  if (cert.state === 'MISSING') problems.push('Cadastre o certificado digital A1.');
  if (cert.state === 'EXPIRED') problems.push('O certificado digital está vencido.');
  if (kind === 'NFCE' && (!settings.cscId || !settings.cscTokenEnc)) problems.push('Informe o CSC (ID e código) para NFC-e.');
  return problems;
}

// Credentials handed to the provider for one call; never logged or returned by the API.
export function fiscalContext(settings: FiscalSettings | null, extra: Partial<FiscalContext> = {}): FiscalContext {
  const reveal = (value: string | null) => (value ? openSecret(value).toString('utf8') : null);
  return {
    environment: environmentOf(settings), issuer: issuerOf(settings), crt: crtOf(issuerOf(settings).taxRegime),
    token: settings?.providerTokenEnc ? reveal(settings.providerTokenEnc) : null,
    csc: settings?.cscId && settings.cscTokenEnc ? { id: settings.cscId, token: reveal(settings.cscTokenEnc)! } : null,
    certificate: settings?.certPfxEnc && settings.certPasswordEnc ? { pfxBase64: openSecret(settings.certPfxEnc).toString('base64'), password: reveal(settings.certPasswordEnc)! } : null,
    contingency: false, ...extra,
  };
}

export function publicSettings(settings: FiscalSettings | null, registeredProviders: string[]) {
  const issuer = issuerOf(settings);
  return {
    configured: Boolean(settings), environment: environmentOf(settings), provider: settings?.provider ?? null, providers: registeredProviders,
    hasProviderToken: Boolean(settings?.providerTokenEnc), cscId: settings?.cscId ?? '', hasCscToken: Boolean(settings?.cscTokenEnc),
    issuer, crt: crtOf(issuer.taxRegime), nfe: modelOf(settings, 'NFE'), nfce: modelOf(settings, 'NFCE'),
    pdvMode: (settings?.pdvMode ?? 'NON_FISCAL') as PdvMode, defaultTaxRuleId: settings?.defaultTaxRuleId ?? null,
    certificate: settings?.certPfxEnc ? { subject: settings.certSubject, cnpj: settings.certCnpj, validFrom: settings.certValidFrom, validTo: settings.certValidTo, uploadedAt: settings.certUploadedAt, ...certificateStatus(settings) } : { ...certificateStatus(settings) },
    readiness: { NFCE: readinessProblems(settings, 'NFCE', registeredProviders), NFE: readinessProblems(settings, 'NFE', registeredProviders) },
  };
}
