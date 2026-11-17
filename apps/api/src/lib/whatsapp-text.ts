import { localParts } from './scheduling';

export const normalizeText = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9#:/.,\s-]/g, ' ').replace(/\s+/g, ' ').trim();

const words = (text: string) => normalizeText(text).replace(/[#:/.,-]/g, ' ').split(' ').filter(Boolean);

export function hasAny(text: string, candidates: string[]): boolean {
  const normalized = ` ${normalizeText(text).replace(/[#:/.,-]/g, ' ')} `;
  return candidates.some(candidate => normalized.includes(` ${candidate} `) || (candidate.length >= 6 && normalized.includes(candidate)));
}

// Brazilian numbers appear with and without the ninth digit; compare country code + last 8 digits.
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.replace(/\D/g, ''); const y = b.replace(/\D/g, '');
  if (x === y) return true;
  if (x.length < 10 || y.length < 10) return false;
  const local = (value: string) => value.replace(/^55/, '');
  const lx = local(x); const ly = local(y);
  return lx.slice(0, 2) === ly.slice(0, 2) && lx.slice(-8) === ly.slice(-8) && Math.abs(lx.length - ly.length) <= 1;
}

// Splits long replies on line breaks so each WhatsApp message stays well below the 4096-character limit.
export function chunkMessage(text: string, limit = 3000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = []; let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) { parts.push(current); current = line; } else current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

// Product matching: every distinctive query word must appear (as a prefix) in the product name.
const STOP = new Set(['de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'um', 'uma', 'com', 'sem', 'para', 'pra', 'por', 'tem', 'quanto', 'custa', 'preco', 'valor', 'voces', 'vcs', 'ai', 'ae', 'me', 'quero', 'queria', 'gostaria', 'saber', 'qual', 'quais', 'e', 'no', 'na', 'em', 'se', 'ter', 'tenho', 'sao', 'esta', 'esse', 'essa', 'isso', 'que', 'ou', 'favor', 'por', 'hoje', 'ainda', 'tambem']);
export function distinctiveWords(text: string): string[] { return words(text).filter(word => word.length >= 3 && !STOP.has(word)); }

export function matchScore(query: string, name: string): number {
  const q = distinctiveWords(query); const n = words(name);
  if (q.length === 0 || n.length === 0) return 0;
  const hits = q.filter(word => n.some(target => target === word || (word.length >= 4 && (target.startsWith(word) || word.startsWith(target) && target.length >= 4))));
  if (hits.length === 0) return 0;
  const coverage = hits.length / n.filter(word => word.length >= 3 && !STOP.has(word)).length;
  return hits.length + Math.min(1, coverage);
}

const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

// Local wall-clock time in `timeZone` -> UTC instant (iterates once to absorb the zone offset).
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const [y, m, d] = parts.day.split('-').map(Number);
    const shown = Date.UTC(y, m - 1, d, Math.floor(parts.minutes / 60), parts.minutes % 60);
    guess += Date.UTC(year, month - 1, day, hour, minute) - shown;
  }
  return new Date(guess);
}

export type ParsedWhen = { at: Date } | { error: 'NO_TIME' | 'NO_DATE' | 'PAST' | 'TOO_FAR' | 'INVALID' };

// Understands "25/12 20:00", "25/12/2026 20h30", "hoje 20h", "amanhã 19:30", "sábado 21h".
export function parseWhen(input: string, timeZone: string, now = new Date()): ParsedWhen {
  const text = normalizeText(input);
  const time = text.match(/(?:^|\s)(\d{1,2})\s*(?::|h)\s*(\d{2})?(?=\s|$)/) ?? text.match(/(?:^|\s)(\d{1,2})\s*(?:horas?|hrs?)(?=\s|$)/) ?? text.match(/\bas\s+(\d{1,2})(?=\s|$)/);
  if (!time) return { error: 'NO_TIME' };
  const hour = Number(time[1]); const minute = Number(time[2] ?? 0);
  if (hour > 23 || minute > 59) return { error: 'INVALID' };
  const today = localParts(now, timeZone); const [ty, tm, td] = today.day.split('-').map(Number);
  let y = ty; let m = tm; let d = td;
  const dateMatch = text.replace(time[0], ' ').match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dateMatch) {
    d = Number(dateMatch[1]); m = Number(dateMatch[2]);
    if (dateMatch[3]) y = Number(dateMatch[3]) < 100 ? 2000 + Number(dateMatch[3]) : Number(dateMatch[3]);
    else if (localToUtc(y, m, d, hour, minute, timeZone) < now) y += 1;
    if (m < 1 || m > 12 || d < 1 || d > 31) return { error: 'INVALID' };
  } else if (/\bhoje\b/.test(text)) { /* today */ }
  else if (/\bamanha\b/.test(text)) { const next = new Date(Date.UTC(ty, tm - 1, td + 1)); y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate(); }
  else {
    const name = Object.keys(WEEKDAYS).find(key => new RegExp(`\\b${key}`).test(text));
    if (name === undefined) return { error: 'NO_DATE' };
    const ahead = (WEEKDAYS[name] - today.weekday + 7) % 7;
    const base = new Date(Date.UTC(ty, tm - 1, td + (ahead === 0 && localToUtc(ty, tm, td, hour, minute, timeZone) < now ? 7 : ahead)));
    y = base.getUTCFullYear(); m = base.getUTCMonth() + 1; d = base.getUTCDate();
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return { error: 'INVALID' };
  const at = localToUtc(y, m, d, hour, minute, timeZone);
  if (at.getTime() < now.getTime() + 30 * 60 * 1000) return { error: 'PAST' };
  if (at.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1000) return { error: 'TOO_FAR' };
  return { at };
}

export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(',', ' às');
}
