'use client';

import Link from './nav-link';
import type { ReactNode } from 'react';
import { RmLogo } from './rm-logo';

// Shared building blocks of the RM visual language: dark chrome (top bar/sidebar), light work surface, gold accent.

export function PageHeader({ title, subtitle, actions, backHref }: { title: string; subtitle?: string; actions?: ReactNode; backHref?: string }) {
  return <section className="rm-gold-card mb-4 flex flex-wrap items-center justify-between gap-3 bg-neutral-950/90 p-4 text-white sm:p-5 print:hidden">
    <div className="min-w-0">
      {backHref && <Link href={backHref} className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-brand-300 hover:text-brand-400">‹ Voltar</Link>}
      <h2 className="truncate text-lg font-bold tracking-tight text-white sm:text-xl"><span className="rm-pulse text-brand-300">◆</span> {title}</h2>
      {subtitle && <p className="mt-1 max-w-3xl text-sm text-neutral-300">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </section>;
}

// Black card with gold frame and an optional numbered badge; the content sits on a light panel (the PDF's "numbered section" pattern).
export function GoldCard({ number, title, subtitle, actions, children }: { number?: number; title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="rm-gold-card mb-6 bg-neutral-950/90 p-2 text-white">
    <header className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        {number !== undefined && <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-b from-brand-300 to-brand-600 text-sm font-extrabold text-neutral-950 ring-2 ring-brand-400/40">{number}</span>}
        <div className="min-w-0"><h2 className="truncate text-base font-bold text-white">{title}</h2>{subtitle && <p className="truncate text-xs text-neutral-400">{subtitle}</p>}</div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
    <div className="rounded-xl bg-white p-4 text-slate-900 sm:p-5">{children}</div>
  </section>;
}

// Page banner: brand logo, headline and gold-framed shortcut tiles, as in the PDF's header.
export function HeroBanner({ title, highlight, text, tiles }: { title: string; highlight: string; text: string; tiles: { href: string; icon: string; label: string }[] }) {
  return <section className="rm-gold-card rm-hero mb-6 flex flex-wrap items-center gap-x-8 gap-y-5 bg-neutral-950/90 p-5 text-white print:hidden">
    <RmLogo className="h-24 w-28 shrink-0 text-white" />
    <div className="min-w-0 flex-1 basis-72 border-brand-500/30 lg:border-l lg:pl-8">
      <p className="rm-eyebrow mb-1">Centro de comando</p>
      <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h2>
      <p className="mt-1 bg-gradient-to-r from-white via-brand-300 to-brand-400 bg-clip-text text-base font-semibold text-transparent">{highlight}</p>
      <p className="mt-2 max-w-xl text-sm text-neutral-300">{text}</p>
    </div>
    <nav aria-label="Atalhos" className="flex flex-wrap gap-2.5">
      {tiles.map(tile => <Link key={tile.href} href={tile.href} className="group flex w-[5.5rem] flex-col items-center gap-1.5 text-center text-[11px] font-medium leading-tight text-neutral-200 hover:text-brand-300">
        <span aria-hidden="true" className="grid h-14 w-14 place-items-center rm-tile-icon rounded-xl border border-brand-500/70 bg-gradient-to-b from-neutral-900 to-black text-2xl transition duration-300 group-hover:-translate-y-0.5 group-hover:border-brand-300">{tile.icon}</span>{tile.label}
      </Link>)}
    </nav>
  </section>;
}

export function Tabs<T extends string>({ tabs, value, onChange, label = 'Seções' }: { tabs: { key: T; label: string }[]; value: T; onChange: (key: T) => void; label?: string }) {
  return <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-brand-500/40 bg-neutral-950 p-1 shadow-[0_0_20px_rgb(var(--b-500)/0.12)] print:hidden">
    {tabs.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={value === tab.key} onClick={() => onChange(tab.key)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${value === tab.key ? 'bg-gradient-to-b from-brand-300 to-brand-500 text-neutral-950 shadow' : 'text-neutral-300 hover:bg-white/10 hover:text-white'}`}>{tab.label}</button>)}
  </div>;
}

// Vertical section list used by the settings screens.
export function SideTabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; icon?: string }[]; value: T; onChange: (key: T) => void }) {
  return <nav aria-label="Seções" className="flex gap-2 overflow-x-auto rounded-2xl border border-brand-500/40 bg-neutral-950 p-2 shadow-sm lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-visible">
    {tabs.map(tab => <button key={tab.key} type="button" aria-current={value === tab.key ? 'page' : undefined} onClick={() => onChange(tab.key)} className={`flex items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${value === tab.key ? 'bg-gradient-to-b from-brand-300 to-brand-500 font-semibold text-neutral-950' : 'text-neutral-300 hover:bg-white/10 hover:text-white'}`}>{tab.icon && <span aria-hidden="true" className="w-5 text-center">{tab.icon}</span>}{tab.label}</button>)}
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
  return <div className="rm-glass grid place-items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
    <span aria-hidden="true" className="text-4xl">{icon}</span>
    <p className="mt-3 font-semibold text-slate-800">{title}</p>
    {hint && <p className="mt-1 max-w-md text-sm text-slate-500">{hint}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>;
}

export function DataTable({ columns, children, footer }: { columns: { label: string; className?: string }[]; children: ReactNode; footer?: ReactNode }) {
  return <div className="rm-glass overflow-hidden rounded-2xl border border-brand-500/40 bg-white">
    <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
      <thead className="bg-neutral-950 text-[11px] font-semibold uppercase tracking-wider text-brand-300"><tr>{columns.map(column => <th key={column.label} scope="col" className={`px-4 py-3 ${column.className ?? ''}`}>{column.label}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100 [&_td]:px-4 [&_td]:py-3 [&_tr:hover]:bg-brand-50/40">{children}</tbody>
    </table></div>
    {footer && <div className="border-t border-slate-100 px-4 py-2 text-right text-xs text-slate-500">{footer}</div>}
  </div>;
}

const badgeTones = { neutral: 'bg-slate-100 text-slate-700', gold: 'bg-brand-100 text-brand-700', green: 'bg-emerald-100 text-emerald-800', red: 'bg-red-100 text-red-800', blue: 'bg-sky-100 text-sky-800', amber: 'bg-amber-100 text-amber-800' } as const;
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={`rm-badge-dot inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeTones[tone]}`}>{children}</span>;
}

export function StatCard({ label, value, hint, tone = 'default', icon }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'dark'; icon?: string }) {
  return <div className={`flex items-start gap-3 rounded-2xl border p-4 ${tone === 'dark' ? 'rm-gold-card border-brand-500/60 bg-neutral-950 text-white shadow-[0_0_22px_rgb(var(--b-500)/0.2)]' : 'rm-glass border-brand-500/30 bg-white text-slate-900'}`}>
    {icon && <span aria-hidden="true" className={`rm-tile-icon grid h-11 w-11 shrink-0 place-items-center rounded-full border text-xl ${tone === 'dark' ? 'border-brand-400/60 bg-brand-500/10' : 'border-brand-300 bg-brand-50'}`}>{icon}</span>}
    <div className="min-w-0">
      <p className={`text-[11px] font-semibold uppercase tracking-wider ${tone === 'dark' ? 'text-brand-300' : 'text-slate-500'}`}>{label}</p>
      <p className="rm-num mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className={`mt-1 text-xs ${tone === 'dark' ? 'text-neutral-400' : 'text-slate-500'}`}>{hint}</p>}
    </div>
  </div>;
}

export const textareaClass = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15';
export const dangerButtonClass = 'rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50';
export const sectionTitleClass = 'mb-3 border-b border-slate-200 pb-2 text-center text-sm font-bold uppercase tracking-wider text-slate-700';

// Loading placeholders: same footprint as the content they stand for, so nothing jumps when the real data arrives.
export function Skeleton({ className = 'h-5 w-full' }: { className?: string }) {
  return <span aria-hidden="true" className={`rm-skeleton block ${className}`} />;
}
export function PanelSkeleton({ lines = 4, label = 'Carregando…' }: { lines?: number; label?: string }) {
  return <div role="status" aria-label={label} className="space-y-3">{Array.from({ length: lines }, (_, index) => <Skeleton key={index} className={`h-4 ${index === 0 ? 'w-1/2' : index % 2 ? 'w-full' : 'w-4/5'}`} />)}<span className="sr-only">{label}</span></div>;
}
