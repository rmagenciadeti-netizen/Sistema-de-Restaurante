'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared building blocks of the RM visual language: dark chrome (top bar/sidebar), light work surface, gold accent.

export function PageHeader({ title, subtitle, actions, backHref }: { title: string; subtitle?: string; actions?: ReactNode; backHref?: string }) {
  return <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 print:hidden">
    <div className="min-w-0">
      {backHref && <Link href={backHref} className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-600">‹ Voltar</Link>}
      <h2 className="truncate text-lg font-bold tracking-tight text-slate-900 sm:text-xl">{title}</h2>
      {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </section>;
}

export function Tabs<T extends string>({ tabs, value, onChange, label = 'Seções' }: { tabs: { key: T; label: string }[]; value: T; onChange: (key: T) => void; label?: string }) {
  return <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm print:hidden">
    {tabs.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={value === tab.key} onClick={() => onChange(tab.key)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${value === tab.key ? 'bg-neutral-950 text-brand-300 shadow' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>{tab.label}</button>)}
  </div>;
}

// Vertical section list used by the settings screens.
export function SideTabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; icon?: string }[]; value: T; onChange: (key: T) => void }) {
  return <nav aria-label="Seções" className="flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-visible">
    {tabs.map(tab => <button key={tab.key} type="button" aria-current={value === tab.key ? 'page' : undefined} onClick={() => onChange(tab.key)} className={`flex items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${value === tab.key ? 'bg-neutral-950 text-brand-300' : 'text-slate-700 hover:bg-slate-100'}`}>{tab.icon && <span aria-hidden="true" className="w-5 text-center">{tab.icon}</span>}{tab.label}</button>)}
  </nav>;
}

export function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={`flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer hover:border-brand-300'}`}>
    <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0">
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="absolute inset-0 rounded-full bg-slate-300 transition peer-checked:bg-brand-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40" />
      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
    </span>
    <span><span className="block font-medium text-slate-900">{label}</span>{hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}</span>
  </label>;
}

export function EmptyState({ icon = '📭', title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }) {
  return <div className="grid place-items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
    <span aria-hidden="true" className="text-4xl">{icon}</span>
    <p className="mt-3 font-semibold text-slate-800">{title}</p>
    {hint && <p className="mt-1 max-w-md text-sm text-slate-500">{hint}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>;
}

export function DataTable({ columns, children, footer }: { columns: { label: string; className?: string }[]; children: ReactNode; footer?: ReactNode }) {
  return <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
      <thead className="bg-neutral-950 text-[11px] font-semibold uppercase tracking-wider text-brand-300"><tr>{columns.map(column => <th key={column.label} scope="col" className={`px-4 py-3 ${column.className ?? ''}`}>{column.label}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100 [&_td]:px-4 [&_td]:py-3 [&_tr:hover]:bg-brand-50/40">{children}</tbody>
    </table></div>
    {footer && <div className="border-t border-slate-100 px-4 py-2 text-right text-xs text-slate-500">{footer}</div>}
  </div>;
}

const badgeTones = { neutral: 'bg-slate-100 text-slate-700', gold: 'bg-brand-100 text-brand-700', green: 'bg-emerald-100 text-emerald-800', red: 'bg-red-100 text-red-800', blue: 'bg-sky-100 text-sky-800', amber: 'bg-amber-100 text-amber-800' } as const;
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeTones[tone]}`}>{children}</span>;
}

export function StatCard({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'dark' }) {
  return <div className={`rounded-2xl border p-4 shadow-sm ${tone === 'dark' ? 'border-neutral-800 bg-neutral-950 text-white' : 'border-slate-200 bg-white text-slate-900'}`}>
    <p className={`text-[11px] font-semibold uppercase tracking-wider ${tone === 'dark' ? 'text-brand-300' : 'text-slate-500'}`}>{label}</p>
    <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
    {hint && <p className={`mt-1 text-xs ${tone === 'dark' ? 'text-neutral-400' : 'text-slate-500'}`}>{hint}</p>}
  </div>;
}

export const textareaClass = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15';
export const dangerButtonClass = 'rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50';
export const sectionTitleClass = 'mb-3 border-b border-slate-200 pb-2 text-center text-sm font-bold uppercase tracking-wider text-slate-700';
