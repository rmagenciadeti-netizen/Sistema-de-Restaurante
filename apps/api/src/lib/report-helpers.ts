import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { localParts } from './scheduling';

export type ReportColumnType = 'text' | 'money' | 'number' | 'percent' | 'datetime';
export type ReportColumn = { key: string; label: string; type: ReportColumnType };
export type ReportRow = Record<string, unknown>;
export type ReportBody = { columns: ReportColumn[]; rows: ReportRow[]; totals?: ReportRow; truncated?: boolean };
export type TabularReport = ReportBody & { kind: string; period: { from: string; to: string } };

export const D = (value: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(value ?? 0);
export const sumDecimals = (values: Array<Prisma.Decimal.Value | null | undefined>) => values.reduce<Prisma.Decimal>((total, value) => total.add(D(value)), new Prisma.Decimal(0));

// `from`/`to` are ISO instants; defaults to "today until now" like the overview report.
export function parsePeriod(query: Request['query']): { from: Date; to: Date } | null {
  const from = typeof query.from === 'string' ? new Date(query.from) : new Date(new Date().setHours(0, 0, 0, 0));
  const to = typeof query.to === 'string' ? new Date(query.to) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  return { from, to };
}

export function tenantScope(req: Request) {
  return { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
}

// Percentage (0-100) rounded to two places; zero base yields zero.
export function percentOf(part: Prisma.Decimal.Value, base: Prisma.Decimal.Value): number {
  const divisor = D(base);
  return divisor.isZero() ? 0 : D(part).div(divisor).mul(100).toDecimalPlaces(2).toNumber();
}

export const dayKey = (date: Date, timeZone: string) => localParts(date, timeZone).day;

export function formatDay(day: string) {
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${year}`;
}

// Decimals become fixed strings and dates ISO strings, so the payload never depends on Prisma's JSON hooks.
export function serializeValue(value: unknown, type?: ReportColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return type === 'money' ? (value as Prisma.Decimal).toFixed(2) : (value as Prisma.Decimal).toString();
  if (type === 'money' && typeof value === 'number') return value.toFixed(2);
  return value;
}

export function finalizeReport(kind: string, period: { from: Date; to: Date }, body: ReportBody): TabularReport {
  const types = new Map(body.columns.map(column => [column.key, column.type]));
  const convert = (row: ReportRow) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value, types.get(key))]));
  return {
    kind, period: { from: period.from.toISOString(), to: period.to.toISOString() }, columns: body.columns, rows: body.rows.map(convert),
    ...(body.totals ? { totals: convert(body.totals) } : {}), ...(body.truncated ? { truncated: true } : {}),
  };
}

const decimalComma = (value: string | number) => String(value).replace('.', ',');

function csvCell(value: unknown, type: ReportColumnType, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '';
  let text: string;
  if (type === 'money') text = decimalComma(D(value as Prisma.Decimal.Value).toFixed(2));
  else if (type === 'number' || type === 'percent') text = decimalComma(typeof value === 'number' || typeof value === 'string' ? value : String(value));
  else if (type === 'datetime') {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) text = String(value);
    else {
      const parts = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
      const get = (name: string) => parts.find(part => part.type === name)?.value ?? '';
      text = `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
    }
  } else {
    text = String(value);
    // Customer-controlled text must not be interpreted as a spreadsheet formula.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  }
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// UTF-8 with BOM and ';' separator, which is what Excel in pt-BR expects.
export function reportToCsv(report: TabularReport, timeZone: string): string {
  const header = report.columns.map(column => csvCell(column.label, 'text', timeZone)).join(';');
  const line = (row: ReportRow) => report.columns.map(column => csvCell(row[column.key], column.type, timeZone)).join(';');
  const lines = [header, ...report.rows.map(line)];
  if (report.totals) {
    const totals = { ...report.totals };
    const first = report.columns.find(column => column.type === 'text');
    if (first && (totals[first.key] === undefined || totals[first.key] === null)) totals[first.key] = 'Totais';
    lines.push(line(totals));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
