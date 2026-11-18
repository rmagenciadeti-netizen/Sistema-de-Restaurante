'use client';

import { useState, type ReactNode } from 'react';
import { saveText } from '../../lib/api';
import { buttonClass, secondaryButtonClass } from '../app-shell';
import { GoldCard, textareaClass } from '../ui';

export type Period = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export const periodLabels: Record<Period, string> = { MONTHLY: 'Mensal', QUARTERLY: 'Trimestral', SEMIANNUAL: 'Semestral', ANNUAL: 'Anual' };
export type CatalogStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export const statusLabels: Record<string, string> = { DRAFT: 'Rascunho', ACTIVE: 'Ativo', INACTIVE: 'Inativo', ARCHIVED: 'Arquivado', SCHEDULED: 'Agendada', ENDED: 'Encerrada', CANCELLED: 'Cancelada', OPEN: 'Em aberto', PAID: 'Paga', OVERDUE: 'Vencida' };
export const statusTone = (status: string): 'green' | 'gold' | 'red' | 'neutral' | 'blue' =>
  ({ ACTIVE: 'green', PAID: 'green', DRAFT: 'neutral', SCHEDULED: 'blue', OPEN: 'gold', INACTIVE: 'neutral', ARCHIVED: 'neutral', ENDED: 'neutral', CANCELLED: 'red', OVERDUE: 'red' } as const)[status as 'ACTIVE'] ?? 'neutral';

export type ModuleRow = {
  id: string; key: string; name: string; description: string | null; category: string; icon: string | null; status: CatalogStatus; blocked: boolean;
  billing: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME' | 'FREE'; monthlyPrice: string | number; annualPrice: string | number; oneTimePrice: string | number;
  promoPrice: string | number | null; promoStartsAt: string | null; promoEndsAt: string | null; standalone: boolean; dependsOn: string[];
  featureLinked: boolean; plans: { id: string; name: string; optional: boolean }[]; tenants: number;
};
export type PlanRow = {
  id: string; key: string; name: string; description: string | null; headline: string | null; benefits: string[]; highlight: string | null; displayOrder: number;
  status: CatalogStatus; active: boolean; trialDays: number; maxUnits: number | null; maxUsers: number | null; activationFee: string | number; setupFee: string | number;
  originalPrice: string | number | null; promoPrice: string | number | null; conditions: string | null; modules: string[]; optionalModules: { key: string; priceOverride: string | number | null }[];
  prices: { period: Period; amount: string | number }[]; _count?: { licenses: number; invoices: number };
};

export const toDateInput = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
export const fromDateInput = (value: string) => (value ? new Date(value).toISOString() : null);
export const num = (value: string) => (value === '' ? null : Number(value));

export function exportCsv(fileName: string, header: string[], rows: (string | number)[][]) {
  const escape = (cell: string | number) => `"${String(cell).replace(/"/g, '""')}"`;
  saveText(`\uFEFF${[header, ...rows].map(row => row.map(escape).join(';')).join('\n')}`, fileName, 'text/csv;charset=utf-8');
}

// Critical actions always require a written reason, which ends up in the audit trail.
export function ReasonDialog({ title, confirmLabel = 'Confirmar', danger, onCancel, onConfirm, children }: { title: string; confirmLabel?: string; danger?: boolean; onCancel: () => void; onConfirm: (reason: string) => void | Promise<void>; children?: ReactNode }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
    <form className="w-full max-w-md space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" onSubmit={async event => { event.preventDefault(); setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }}>
      <h3 className="text-lg font-bold text-slate-900">{title}</h3>
      {children}
      <label className="block text-sm font-medium text-slate-700">Motivo (registrado na auditoria)
        <textarea required minLength={3} maxLength={300} value={reason} onChange={event => setReason(event.target.value)} className={textareaClass} rows={3} autoFocus />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onCancel}>Voltar</button>
        <button className={danger ? 'rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50' : buttonClass} disabled={busy || reason.trim().length < 3}>{busy ? 'Aguarde...' : confirmLabel}</button>
      </div>
    </form>
  </div>;
}

export function Section({ title, actions, number, children }: { title: string; actions?: ReactNode; number?: number; children: ReactNode }) {
  return <GoldCard title={title} actions={actions} number={number}>{children}</GoldCard>;
}

export function MultiPick({ label, options, value, onChange }: { label: string; options: { key: string; name: string }[]; value: string[]; onChange: (next: string[]) => void }) {
  return <fieldset className="rounded-xl border border-slate-200 p-3">
    <legend className="px-1 text-sm font-medium text-slate-700">{label} <span className="text-xs font-normal text-slate-500">(vazio = todos)</span></legend>
    <div className="grid max-h-36 gap-1 overflow-y-auto sm:grid-cols-2">
      {options.map(option => <label key={option.key} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={value.includes(option.key)} onChange={event => onChange(event.target.checked ? [...value, option.key] : value.filter(item => item !== option.key))} />{option.name}</label>)}
    </div>
  </fieldset>;
}
