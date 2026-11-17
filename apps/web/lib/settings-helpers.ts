import { ApiError } from './api';
import type { Slot } from './settings';

export const MANAGEMENT_ROLES = ['ADMIN', 'MANAGER'];

const passwordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function suggestPassword(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => passwordAlphabet[byte % passwordAlphabet.length]).join('');
}

// Turns the API validation payload into readable text; falls back to the plain message.
export function saveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const errors = error.payload.errors as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
    const details = [...(errors?.formErrors ?? []), ...Object.entries(errors?.fieldErrors ?? {}).map(([field, list]) => `${field}: ${list.join(', ')}`)];
    if (details.length > 0) return `Não foi possível salvar. ${details.join(' · ')}`;
    if (error.status === 403) return 'Seu perfil não tem permissão para esta ação.';
  }
  return error instanceof Error ? error.message : fallback;
}

export const eanCheckDigit = (digits: string) => {
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) sum += Number(digits[index]) * weight;
  return (10 - (sum % 10)) % 10;
};

export type ScaleExampleConfig = { prefix: string; codeLength: number; barcodeLength: number; saleType: 'WEIGHT' | 'PRICE' };

// Mirrors the API's buildScaleBarcode so the settings screen can preview the label layout. Returns null when the layout cannot fit.
export function scaleBarcodeExample(config: ScaleExampleConfig, scaleCode: number, value: number) {
  const valueLength = config.barcodeLength - config.prefix.length - config.codeLength - 1;
  if (valueLength < 1) return null;
  const raw = Math.round(config.saleType === 'WEIGHT' ? value * 1000 : value * 100);
  if (!Number.isFinite(raw) || raw < 0 || String(raw).length > valueLength || String(scaleCode).length > config.codeLength) return null;
  const code = String(scaleCode).padStart(config.codeLength, '0');
  const amount = String(raw).padStart(valueLength, '0');
  const body = `${config.prefix}${code}${amount}`;
  return { prefix: config.prefix, code, amount, check: String(eanCheckDigit(body)), barcode: `${body}${eanCheckDigit(body)}` };
}

export function marginSimulation(cost: number, marginPercent: number) {
  const price = Math.round(cost * (1 + marginPercent / 100) * 100) / 100;
  return { price, profit: Math.round((price - cost) * 100) / 100 };
}

export const slotsOfDay = (slots: Slot[], day: number) => slots.filter(slot => slot.day === day);
export const replaceDaySlots = (slots: Slot[], day: number, next: Slot[]): Slot[] => [...slots.filter(slot => slot.day !== day), ...next.map(slot => ({ ...slot, day }))].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
export const invalidSlots = (slots: Slot[]) => slots.filter(slot => !slot.start || !slot.end || slot.start >= slot.end);
export const slotSummary = (slots: Slot[]) => (slots.length === 0 ? 'Sem horários' : slots.map(slot => `${slot.start}–${slot.end}`).join(' · '));

export type MenuLayoutFile = { app: 'rm-restaurant'; kind: 'menu-layout'; version: 1; hidden: string[] };
export const serializeMenuLayout = (hidden: string[]) => JSON.stringify({ app: 'rm-restaurant', kind: 'menu-layout', version: 1, hidden } satisfies MenuLayoutFile, null, 2);

// Returns only hrefs that exist in the current menu; null when the file is not a menu layout.
export function parseMenuLayout(text: string, validHrefs: string[]): string[] | null {
  try {
    const data = JSON.parse(text) as Partial<MenuLayoutFile>;
    if (data.kind !== 'menu-layout' || !Array.isArray(data.hidden)) return null;
    const valid = new Set(validHrefs);
    return Array.from(new Set(data.hidden.filter((href): href is string => typeof href === 'string' && valid.has(href))));
  } catch { return null; }
}
