'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney, ListResponse, toIso } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import { toLocalInput, type CoverEvent, type DeleteResult } from '../../lib/types-registry';

const emptyForm = { description: '', amount: '', startsAt: '', endsAt: '', active: true };

export default function CoverEventsPage() {
  const [items, setItems] = useState<CoverEvent[]>([]);
  const [current, setCurrent] = useState<CoverEvent | null>(null);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<CoverEvent | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string } = {}) {
    const params = new URLSearchParams();
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try {
      const [list, now] = await Promise.all([api<ListResponse<CoverEvent>>(`/cover-events?${params}`), api<CoverEvent | null>('/cover-events/current')]);
      setItems(list.items); setCurrent(now);
    } catch (e) { fail(e, 'Erro ao carregar eventos'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(event: CoverEvent | 'new') {
    setNotice(null); setEditing(event);
    setForm(event === 'new' ? emptyForm : { description: event.description, amount: String(Number(event.amount)), startsAt: toLocalInput(event.startsAt), endsAt: toLocalInput(event.endsAt), active: event.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    if (new Date(form.endsAt) <= new Date(form.startsAt)) { setNotice({ text: 'A data final deve ser posterior à data inicial.', kind: 'error' }); return; }
    setSaving(true);
    const body = JSON.stringify({ description: form.description, amount: Number(form.amount), startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt), active: form.active });
    try {
      if (editing === 'new') await api('/cover-events', { method: 'POST', body }); else await api(`/cover-events/${editing!.id}`, { method: 'PATCH', body });
      ok('Evento salvo.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar evento'); } finally { setSaving(false); }
  }
  async function toggle(event: CoverEvent) {
    try { await api(`/cover-events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ active: !event.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar evento'); }
  }
  async function remove(event: CoverEvent) {
    if (!window.confirm(`Excluir o evento ${event.description}? Pedidos já lançados mantêm o valor cobrado.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/cover-events/${event.id}`, { method: 'DELETE' }), 'Evento')); await load(); } catch (e) { fail(e, 'Erro ao excluir evento'); }
  }

  return <AppShell title="Couvert artístico">
    <PageHeader title="Couvert artístico" subtitle="Cadastre os eventos com cobrança por pessoa. Durante o período, o caixa pode lançar o couvert nos pedidos." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {current && <p className="mb-4 rounded-xl border border-brand-300 bg-brand-50 px-4 py-3 text-sm text-slate-800"><Badge tone="gold">Vigente agora</Badge> <strong>{current.description}</strong> — {formatMoney(current.amount)} por pessoa, até {formatDateTime(current.endsAt)}.</p>}
    {editing && <FormCard title={editing === 'new' ? 'Novo evento' : 'Editar evento'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Descrição" required minLength={2} maxLength={160} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        <Field label="Valor por pessoa (R$)" type="number" required min="0" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
        <Field label="Data inicial" type="datetime-local" required value={form.startsAt} onChange={e => setForm({ ...form, startsAt: e.target.value })} />
        <Field label="Data final" type="datetime-local" required value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} />
      </div>
      <Toggle label="Ativo" hint="Somente eventos ativos dentro do período são oferecidos no caixa." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Descrição do evento" />
    {loaded && items.length === 0 ? <EmptyState icon="🎤" title="Não há registros" hint="Adicione um evento para cobrar couvert artístico." /> :
      <DataTable columns={[{ label: 'Código' }, { label: 'Descrição' }, { label: 'Data inicial' }, { label: 'Data final' }, { label: 'Valor' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(event => <tr key={event.id}>
          <td className="font-mono text-xs text-slate-500" title={event.id}>{event.id.slice(0, 8).toUpperCase()}</td>
          <td className="font-medium text-slate-900">{event.description}</td><td>{formatDateTime(event.startsAt)}</td><td>{formatDateTime(event.endsAt)}</td><td>{formatMoney(event.amount)}</td><td><ActiveBadge active={event.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(event)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(event)}>{event.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(event)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
