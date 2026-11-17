import { z } from 'zod';

// Default CFOPs by operation and destination, stored in FiscalSettings.cfop.
// The first digit encodes direction and destination: 1/2 entrada (estadual/interestadual), 5/6 saída (estadual/interestadual).
const cfopStarting = (first: string, label: string) => z.string().trim().regex(new RegExp(`^([${first}]\\d{3})?$`), `${label}: CFOP de 4 dígitos iniciado por ${first.split('').join(' ou ')}`).optional();
export const cfopSettingsSchema = z.object({
  saleInternal: cfopStarting('5', 'Venda no estado'), saleInterstate: cfopStarting('6', 'Venda interestadual'),
  returnInternal: cfopStarting('15', 'Devolução no estado'), returnInterstate: cfopStarting('26', 'Devolução interestadual'),
  purchaseInternal: cfopStarting('1', 'Entrada no estado'), purchaseInterstate: cfopStarting('2', 'Entrada interestadual'),
});
export type CfopSettings = z.infer<typeof cfopSettingsSchema>;
export const cfopSettingsOf = (value: unknown): CfopSettings => { const parsed = cfopSettingsSchema.safeParse(value ?? {}); return parsed.success ? parsed.data : {}; };

export type Destination = 'INTERNAL' | 'INTERSTATE';
// NFC-e is always a face-to-face consumer sale inside the issuer's state; only NF-e can be interstate.
export function destinationOf(kind: 'NFE' | 'NFCE', issuerUf: string, recipientUf?: string | null): Destination {
  const uf = (recipientUf ?? '').trim().toUpperCase();
  return kind === 'NFE' && uf && issuerUf && uf !== issuerUf.toUpperCase() ? 'INTERSTATE' : 'INTERNAL';
}

export type NatureRule = { cfop: string; destination: string; ufOrigin: string | null; ufDestination: string | null; taxRegime: string | null; active: boolean; direction: string };
export type NatureScope = { destination: Destination; issuerUf: string; recipientUf?: string | null; taxRegime: string };
// A nature only applies when every criterion it defines matches the operation (null / ANY = no restriction).
export function natureApplies(nature: NatureRule | null | undefined, scope: NatureScope): boolean {
  if (!nature || !nature.active || nature.direction !== 'OUT') return false;
  if (nature.destination !== 'ANY' && nature.destination !== scope.destination) return false;
  if (nature.ufOrigin && nature.ufOrigin.toUpperCase() !== scope.issuerUf.toUpperCase()) return false;
  if (nature.ufDestination && nature.ufDestination.toUpperCase() !== (scope.recipientUf ?? scope.issuerUf).toUpperCase()) return false;
  if (nature.taxRegime && nature.taxRegime !== scope.taxRegime) return false;
  return true;
}

export type CfopSources = {
  ruleCfop?: string | null; ruleCfopInterstate?: string | null; natureCfop?: string | null; settings: CfopSettings; modelDefault?: string | null;
  destination: Destination; returning: boolean;
};
// Precedence: tax rule (by destination) > matching operation nature > company default (by operation/destination) > document model default.
export function resolveCfop(sources: CfopSources): string | null {
  const interstate = sources.destination === 'INTERSTATE';
  const company = sources.returning ? (interstate ? sources.settings.returnInterstate : sources.settings.returnInternal) : (interstate ? sources.settings.saleInterstate : sources.settings.saleInternal);
  const fromRule = interstate ? sources.ruleCfopInterstate : sources.ruleCfop;
  return fromRule || sources.natureCfop || company || (interstate ? null : sources.modelDefault) || sources.ruleCfop || sources.modelDefault || null;
}
