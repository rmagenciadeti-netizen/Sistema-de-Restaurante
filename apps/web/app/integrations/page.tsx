'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_BASE, api, errorMessage, formatDateTime, Integration, ListResponse, storedUser, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, Tabs } from '../../components/ui';

const example = `{
  "externalId": "PEDIDO-123",
  "customer": { "name": "Maria Silva", "phone": "11999998888" },
  "address": "Rua das Flores, 100 - Centro",
  "deliveryFee": 6.5,
  "items": [
    { "code": "PROD-001", "quantity": 2, "notes": "sem cebola" }
  ]
}`;

function IntegrationsContent() {
  const initialTab = useSearchParams().get('tab');
  const [items, setItems] = useState<Integration[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [form, setForm] = useState({ provider: '', name: '', unitId: '' });
  const [created, setCreated] = useState<{ provider: string; name: string; key: string } | null>(null);
  const [origin, setOrigin] = useState('');
  const [tab, setTab] = useState<'marketplaces' | 'payments'>(initialTab === 'payments' ? 'payments' : 'marketplaces');
  const [providers, setProviders] = useState<{ payment: string[]; fiscal: string[]; email: string[] } | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [list, unitList] = await Promise.all([api<ListResponse<Integration>>('/integrations'), api<ListResponse<Unit>>('/units')]);
      setItems(list.items); setUnits(unitList.items);
      setProviders(await api<{ payment: string[]; fiscal: string[]; email: string[] }>('/integrations/providers').catch(() => null));
      setOrigin(window.location.origin);
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
  const inboundUrl = (provider: string) => `${origin}${API_BASE}/inbound/${provider}/orders`;
  const unitName = (id?: string | null) => units.find(unit => unit.id === id)?.name ?? '—';

  const providerRow = (label: string, hint: string, names: string[] | undefined) => <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"><div><p className="font-semibold text-slate-900">{label}</p><p className="text-xs text-slate-500">{hint}</p></div><div className="flex flex-wrap gap-2">{names && names.length > 0 ? names.map(name => <Badge key={name} tone="green">{name}</Badge>) : <Badge tone="amber">Nenhum adaptador registrado</Badge>}</div></div>;

  return <AppShell title="Integrações">
    <Tabs label="Integrações" value={tab} onChange={setTab} tabs={[{ key: 'marketplaces', label: 'Marketplaces e API' }, { key: 'payments', label: 'PIX, POS e fiscal' }]} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {tab === 'payments' && <section className={panelClass}>
      <h2 className="text-lg font-semibold">Provedores registrados neste ambiente</h2>
      <p className="mt-1 mb-4 text-sm text-slate-600">PIX, maquininhas (Stone, Cielo, Rede, GetNet, PagSeguro, Mercado Pago…) e emissão fiscal dependem de um adaptador certificado do provedor, com credenciais e homologação próprias. O sistema só mostra como disponível o que foi registrado em <code>providers.config.ts</code> — nada é simulado.</p>
      <div className="grid gap-3">
        {providerRow('Pagamentos (PIX e cartão)', 'Cobranças online e webhooks assinados', providers?.payment)}
        {providerRow('Documentos fiscais (NFC-e/NF-e)', 'Emissão, cancelamento e consulta', providers?.fiscal)}
        {providerRow('E-mail transacional', 'Recuperação de senha e avisos', providers?.email)}
      </div>
      <p className="mt-4 text-xs text-slate-500">Para ativar um provedor, implemente o adaptador conforme as interfaces em <code>apps/api/src/lib/providers.ts</code> e registre-o na inicialização da API.</p>
    </section>}
    {tab === 'marketplaces' && <>
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
      <p className="text-sm text-slate-300">O marketplace deve chamar <code className="text-blue-300">POST {origin}{API_BASE}/inbound/&lt;provedor&gt;/orders</code> com a chave da integração. A URL precisa ser acessível pelo marketplace. Os itens são associados aos produtos pelo <strong>código do produto</strong> (campo “Código” em Produtos); códigos desconhecidos são recusados com erro 422. Os preços do catálogo prevalecem; a taxa de entrega informada é registrada no pedido. Reenvios com o mesmo <code className="text-blue-300">externalId</code> não duplicam o pedido.</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-200">{example}</pre></section>
    </>}
  </AppShell>;
}

export default function IntegrationsPage() {
  return <Suspense fallback={null}><IntegrationsContent /></Suspense>;
}
