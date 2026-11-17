'use client';

import { formatDateTime, formatMoney } from '../lib/api';
import type { ReportColumn, ReportTable } from '../lib/types-reports';
import { Badge, EmptyState } from './ui';

export function formatCell(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'money') return formatMoney(value as string | number);
  if (type === 'number') return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  if (type === 'percent') return `${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (type === 'datetime') return formatDateTime(String(value));
  return String(value);
}

const statusTone: Record<string, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = {
  Pago: 'green', Recebido: 'green', Disponível: 'green', Ativo: 'green', Vigente: 'green', Liberado: 'green', Finalizado: 'green', Fechado: 'neutral', Aberto: 'blue',
  'Estoque baixo': 'amber', 'Aguardando liberação': 'amber', Agendada: 'amber', 'Em aberto': 'amber',
  'Em atraso': 'red', 'Sem estoque': 'red', Cancelado: 'red', Inativo: 'red', Inativa: 'red', Encerrada: 'neutral',
};
const classTone = { A: 'green', B: 'amber', C: 'neutral' } as const;

function Cell({ column, value }: { column: ReportColumn; value: unknown }) {
  const text = formatCell(value, column.type);
  if (column.type === 'text' && typeof value === 'string' && value) {
    if (column.key === 'abc' && value in classTone) return <Badge tone={classTone[value as keyof typeof classTone]}>Classe {value}</Badge>;
    if (['status', 'stock'].includes(column.key) && statusTone[value]) return <Badge tone={statusTone[value]}>{value}</Badge>;
  }
  const negative = column.type === 'money' && Number(value) < 0;
  return <span className={negative ? 'font-medium text-red-700' : undefined}>{text}</span>;
}

const numeric = (column: ReportColumn) => column.type !== 'text' && column.type !== 'datetime';

// Generic table driven by the `columns` of any report; the optional totals row is rendered as a footer.
export function ReportTableView({ table }: { table: ReportTable }) {
  const { columns, rows, totals } = table;
  if (rows.length === 0) return <EmptyState icon="📊" title="Sem dados no período" hint="Ajuste o período ou o filtro para ver resultados." />;
  const firstKey = columns[0]?.key;
  return <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
    <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
      <thead className="bg-neutral-950 text-[11px] font-semibold uppercase tracking-wider text-brand-300 print:bg-white print:text-black">
        <tr>{columns.map(column => <th key={column.key} scope="col" className={`px-4 py-3 ${numeric(column) ? 'text-right' : ''}`}>{column.label}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100 [&_tr:hover]:bg-brand-50/40">
        {rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.key} className={`px-4 py-2.5 ${numeric(column) ? 'text-right tabular-nums' : ''}`}><Cell column={column} value={row[column.key]} /></td>)}</tr>)}
      </tbody>
      {totals && <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
        <tr>{columns.map(column => {
          const value = totals[column.key];
          const empty = value === undefined || value === null || value === '';
          return <td key={column.key} className={`px-4 py-3 ${numeric(column) ? 'text-right tabular-nums' : ''}`}>{empty ? (column.key === firstKey ? 'Totais' : '') : <Cell column={column} value={value} />}</td>;
        })}</tr>
      </tfoot>}
    </table></div>
    {table.truncated && <p className="border-t border-slate-100 px-4 py-2 text-xs text-amber-700">Mostrando apenas os primeiros resultados. Reduza o período para ver tudo.</p>}
  </div>;
}

// Client-side CSV (UTF-8 with BOM, ';') for the reports that are composed locally; the others use GET /reports/x/:kind?format=csv.
export function tableToCsv(table: ReportTable): string {
  const cell = (value: unknown, column: ReportColumn) => {
    if (value === null || value === undefined) return '';
    const text = column.type === 'datetime' ? formatDateTime(String(value)) : column.type === 'text' ? String(value) : String(value).replace('.', ',');
    const safe = column.type === 'text' && /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (row: Record<string, unknown>) => table.columns.map(column => cell(row[column.key], column)).join(';');
  const lines = [table.columns.map(column => cell(column.label, { ...column, type: 'text' })).join(';'), ...table.rows.map(line)];
  if (table.totals) lines.push(line({ [table.columns[0].key]: 'Totais', ...table.totals }));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
