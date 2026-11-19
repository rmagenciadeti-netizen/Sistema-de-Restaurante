'use client';

import { useState } from 'react';
import { api, errorMessage, KdsStage } from '../lib/api';
import { secondaryButtonClass } from './app-shell';

const PHASES: { value: KdsStage['phase']; label: string }[] = [
  { value: 'PENDING', label: 'Pendente (recebido)' },
  { value: 'PREPARING', label: 'Em preparo' },
  { value: 'READY', label: 'Pronto' },
  { value: 'DELIVERED', label: 'Entregue (sai do painel)' },
];
const keyOf = (label: string, taken: Set<string>) => {
  const base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'ESTADO';
  let key = /^[A-Z]/.test(base) ? base : `E_${base}`; let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
};

// Managers name their own production flow. Each stage maps to a real item phase, so order status, stock and printing keep their rules.
export function KdsStagesEditor({ stages, onSaved }: { stages: KdsStage[]; onSaved: (stages: KdsStage[]) => void }) {
  const [draft, setDraft] = useState<KdsStage[]>(stages);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const patch = (index: number, change: Partial<KdsStage>) => setDraft(current => current.map((stage, i) => (i === index ? { ...stage, ...change } : stage)));
  const move = (index: number, step: -1 | 1) => setDraft(current => { const next = [...current]; const target = index + step; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  async function save() {
    setSaving(true); setMessage('');
    try {
      const saved = await api<{ stages: KdsStage[] }>('/production/stages', { method: 'PUT', body: JSON.stringify({ stages: draft }) });
      setDraft(saved.stages); onSaved(saved.stages); setMessage('Estados salvos.');
    } catch (e) { setMessage(errorMessage(e, 'Não foi possível salvar os estados')); } finally { setSaving(false); }
  }
  return <details className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <summary className="cursor-pointer text-base font-bold">Personalizar estados do KDS</summary>
    <p className="mt-2 text-sm text-slate-600">O fluxo segue a ordem abaixo. Cada estado pertence a uma fase real do item (pendente, preparo, pronto ou entregue); o status geral do pedido não muda por causa destes nomes.</p>
    <ol className="mt-3 grid gap-2">{draft.map((stage, index) => <li key={stage.key} className="grid items-center gap-2 sm:grid-cols-[1fr_14rem_4rem_auto]">
      <input aria-label={`Nome do estado ${index + 1}`} value={stage.label} maxLength={40} onChange={e => patch(index, { label: e.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <select aria-label={`Fase do estado ${index + 1}`} value={stage.phase} onChange={e => patch(index, { phase: e.target.value as KdsStage['phase'] })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">{PHASES.map(phase => <option key={phase.value} value={phase.value}>{phase.label}</option>)}</select>
      <input aria-label={`Cor do estado ${index + 1}`} type="color" value={stage.color} onChange={e => patch(index, { color: e.target.value })} className="h-9 w-14 rounded border border-slate-300" />
      <div className="flex gap-1"><button type="button" className={secondaryButtonClass} aria-label="Subir" onClick={() => move(index, -1)}>↑</button><button type="button" className={secondaryButtonClass} aria-label="Descer" onClick={() => move(index, 1)}>↓</button><button type="button" className={secondaryButtonClass} aria-label="Remover estado" disabled={draft.length <= 4} onClick={() => setDraft(current => current.filter((_, i) => i !== index))}>✕</button></div>
    </li>)}</ol>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className={secondaryButtonClass} disabled={draft.length >= 12} onClick={() => setDraft(current => [...current, { key: keyOf('Novo estado', new Set(current.map(stage => stage.key))), label: 'Novo estado', phase: 'PREPARING', color: '#475569' }])}>+ Adicionar estado</button>
      <button type="button" className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-brand-400 disabled:opacity-50" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar estados'}</button>
      {message && <span role="status" className="text-sm text-slate-700">{message}</span>}
    </div>
  </details>;
}
