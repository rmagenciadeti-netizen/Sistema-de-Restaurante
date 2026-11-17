'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse, Unit } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';
import { buttonClass, Field, panelClass, Select } from './app-shell';

type TransferIngredient = { id: string; name: string; unitOfMeasure: string; currentStock: number | string; unitId?: string | null };

export function StockTransfer({ ingredients, onDone, onMessage }: { ingredients: TransferIngredient[]; onDone: () => Promise<void>; onMessage: (text: string, kind: 'error' | 'success') => void }) {
  const [units, setUnits] = useState<Unit[]>([]); const [form, setForm] = useState({ from: '', to: '', quantity: '', note: '' }); const [busy, setBusy] = useState(false);
  useAutoLoad(async () => { try { setUnits((await api<ListResponse<Unit>>('/units')).items); } catch { /* nomes de unidade são opcionais */ } });
  const label = (item: TransferIngredient) => `${item.name} — ${item.unitId ? units.find(unit => unit.id === item.unitId)?.name ?? 'Unidade' : 'Geral'} (${Number(item.currentStock)} ${item.unitOfMeasure})`;
  const source = ingredients.find(item => item.id === form.from);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      await api('/inventory/transfers', { method: 'POST', body: JSON.stringify({ fromIngredientId: form.from, toIngredientId: form.to, quantity: Number(form.quantity), note: form.note || undefined }) });
      setForm({ from: '', to: '', quantity: '', note: '' }); onMessage('Transferência registrada.', 'success'); await onDone();
    } catch (e) { onMessage(errorMessage(e, 'Erro ao transferir estoque'), 'error'); } finally { setBusy(false); }
  }

  return <section className={`${panelClass} xl:col-span-2`}>
    <h2 className="mb-1 text-lg font-semibold">Transferir entre unidades</h2>
    <p className="mb-4 text-sm text-slate-400">Escolha o ingrediente de origem e o ingrediente equivalente no destino (mesma unidade de medida). Requer acesso a todas as unidades.</p>
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Select label="Origem" required value={form.from} onChange={e => setForm({ ...form, from: e.target.value, to: form.to === e.target.value ? '' : form.to })}><option value="">Selecione</option>{ingredients.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}</Select>
      <Select label="Destino" required value={form.to} onChange={e => setForm({ ...form, to: e.target.value })}><option value="">Selecione</option>{ingredients.filter(item => item.id !== form.from && (!source || item.unitOfMeasure === source.unitOfMeasure)).map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}</Select>
      <Field label={`Quantidade${source ? ` (${source.unitOfMeasure})` : ''}`} type="number" min="0.001" step="0.001" required value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} />
      <Field label="Observação (opcional)" maxLength={300} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
      <div><button className={buttonClass} disabled={busy || !form.from || !form.to}>{busy ? 'Transferindo...' : 'Transferir'}</button></div>
    </form>
  </section>;
}
