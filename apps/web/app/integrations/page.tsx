'use client';

import { useState } from 'react';
import { API_BASE, api, errorMessage, formatDateTime, Integration, ListResponse, storedUser, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const example = `{
  "externalId": "PEDIDO-123",
  "customer": { "name": "Maria Silva", "phone": "11999998888" },
  "address": "Rua das Flores, 100 - Centro",
  "deliveryFee": 6.5,
  "items": [
    { "code": "PROD-001", "quantity": 2, "notes": "sem cebola" }
  ]
}`;

export default function IntegrationsPage() {
  const [items, setItems] = useState<Integration[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [form, setForm] = useState({ provider: '', name: '', unitId: '' });
  const [created, setCreated] = useState<{ provider: string; name: string; key: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [list, unitList] = await Promise.all([api<ListResponse<Integration>>('/integrations'), api<ListResponse<Unit>>('/units')]);
      setItems(list.items); setUnits(unitList.items);
      const own = storedUser().unitId; setForm(current => current.unitId ? current : { ...current, unitId: own ?? unitList.items[0]?.id ?? '' });
    } catch (e) { fail(e, 'Erro ao carregar integrações'); }
  }
  useAutoLoad(load);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try {
      const result = await api<Integration & { key: string }>('/integrations', { method: 'POST', body: JSON.stringify({ provider: form.provider.trim().toLowerCase(), name: form.name, unitId: form.unitId }) });
      setCreated({ provider: result.provider, name: result.name, key: result.key }); setForm({ ...form, provider: '', name: '' }); await load();
    } catch (e) { fail(e, 'Erro ao criar integração'); }
  }
  async function toggle(item: Integration) {
    try { await api(`/integrations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar integração'); }
  }
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); ok(`${label} copiado.`); } catch { setNotice({ text: 'Não foi possível copiar; selecione o texto manualmente.', kind: 'error' }); }
  }
  const inboundUrl = (provider: string) => `${API_BASE}/inbound/${provider}/orders`;
  const unitName = (id?: string | null) => units.find(unit => unit.id === id)?.name ?? '—';

  return <AppShell title="Integrações (marketplaces)">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {created && <div role="alert" className="mb-6 rounded-xl border border-amber-400/60 bg-amber-500/10 p-5"><h2 className="font-semibold text-amber-200">Chave da integração “{created.name}”</h2><p className="mt-1 text-sm text-amber-100">Guarde esta chave agora: ela não será exibida novamente. Envie-a no cabeçalho <code>Authorization: Bearer &lt;chave&gt;</code>.</p><code className="mt-3 block select-all break-all rounded-lg bg-slate-950 p-3 text-sm text-white">{created.key}</code><p className="mt-3 text-sm text-amber-100">URL para receber pedidos:</p><code className="block select-all break-all rounded-lg bg-slate-950 p-3 text-sm text-white">POST {inboundUrl(created.provider)}</code><div className="mt-3 flex gap-2"><button className={buttonClass} onClick={() => void copy(created.key, 'Chave')}>Copiar chave</button><button className={secondaryButtonClass} onClick={() => void copy(inboundUrl(created.provider), 'URL')}>Copiar URL</button><button className={secondaryButtonClass} onClick={() => setCreated(null)}>Já guardei a chave</button></div></div>}

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Nova integração</h2>
      <form onSubmit={create} className="grid gap-4 md:grid-cols-4">
        <Field label="Provedor (slug, ex.: ifood)" required pattern="[a-z0-9\-]{2,30}" title="2 a 30 caracteres: letras minúsculas, números e hífen" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} />
        <Field label="Nome" required minLength={2} maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Select label="Unidade que recebe os pedidos" required value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>
        <div className="flex items-end"><button className={buttonClass}>Criar integração</button></div>
      </form></section>

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Integrações ({items.length})</h2><div className="grid gap-3 md:grid-cols-2">{items.map(item => <article key={item.id} className="rounded-lg border border-slate-800 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{item.name} <span className="text-xs font-normal text-slate-400">({item.provider})</span> <span className={`text-xs ${item.active ? 'text-emerald-300' : 'text-red-300'}`}>{item.active ? 'ativa' : 'inativa'}</span></h3><p className="mt-1 text-sm text-slate-400">Unidade: {unitName(item.unitId)} · último uso: {formatDateTime(item.lastUsedAt)}</p><p className="mt-1 break-all text-xs text-slate-500">POST {inboundUrl(item.provider)}</p></div><button className={secondaryButtonClass} onClick={() => void toggle(item)}>{item.active ? 'Desativar' : 'Ativar'}</button></div></article>)}</div>{items.length === 0 && <p className="text-slate-400">Nenhuma integração cadastrada.</p>}</section>

    <section className={panelClass}><h2 className="mb-2 text-lg font-semibold">Como enviar pedidos</h2>
      <p className="text-sm text-slate-300">O marketplace deve chamar <code className="text-blue-300">POST {API_BASE}/inbound/&lt;provedor&gt;/orders</code> com a chave da integração. Os itens são associados aos produtos pelo <strong>código do produto</strong> (campo “Código” em Produtos); códigos desconhecidos são recusados com erro 422. Os preços do catálogo prevalecem; a taxa de entrega informada é registrada no pedido. Reenvios com o mesmo <code className="text-blue-300">externalId</code> não duplicam o pedido.</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-200">{example}</pre></section>
  </AppShell>;
}
