'use client';

import type { ReactNode } from 'react';
import { buttonClass, panelClass, secondaryButtonClass } from './app-shell';
import { Badge } from './ui';

// Shared pieces of the auxiliary registry screens (couriers, carriers, payment methods, ...).

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'neutral'}>{active ? 'Ativo' : 'Inativo'}</Badge>;
}

export function FormCard({ title, onSubmit, onCancel, saving, children }: { title: string; onSubmit: (event: React.FormEvent) => void; onCancel: () => void; saving?: boolean; children: ReactNode }) {
  return <section className={`${panelClass} mb-4`} aria-label={title}>
    <h3 className="mb-4 text-base font-semibold text-slate-900">{title}</h3>
    <form onSubmit={onSubmit} className="grid gap-4">
      {children}
      <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button><button type="button" className={secondaryButtonClass} onClick={onCancel}>Cancelar</button></div>
    </form>
  </section>;
}

// Search box + active filter shared by the list screens.
export function SearchBar({ q, onQ, active, onActive, onSubmit, placeholder }: { q: string; onQ: (value: string) => void; active: string; onActive: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }} className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
    <label className="min-w-0 flex-1 basis-56 text-sm font-medium text-slate-700">Buscar<input type="search" value={q} onChange={event => onQ(event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15" /></label>
    <label className="text-sm font-medium text-slate-700">Situação<select value={active} onChange={event => { onActive(event.target.value); }} className="mt-1 block rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15"><option value="">Todos</option><option value="true">Ativos</option><option value="false">Inativos</option></select></label>
    <button className={secondaryButtonClass}>Buscar</button>
  </form>;
}

export const deleteMessage = (result: { deleted: boolean; deactivated: boolean }, what: string) => result.deactivated ? `${what} possui vínculos e foi desativado em vez de excluído.` : `${what} excluído.`;
