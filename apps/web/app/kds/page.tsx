'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, KdsItem, KdsStage, ListResponse, ProductionSector, userStorageKey } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, Notice, secondaryButtonClass, Select } from '../../components/app-shell';
import { PageHeader, StatCard } from '../../components/ui';
import { KdsStagesEditor } from '../../components/kds-stages-editor';

const columns: { status: KdsItem['status']; label: string; tone: string }[] = [
  { status: 'PENDING', label: 'Pendentes', tone: 'bg-amber-700' },
  { status: 'PREPARING', label: 'Em preparo', tone: 'bg-sky-700' },
  { status: 'READY', label: 'Prontos', tone: 'bg-emerald-700' },
];
type History = { sectors: { sector: string; items: number; expectedMinutes: number | null; averagePrepMinutes: number; averageWaitMinutes: number; late: number; latePercent: number | null }[]; truncated: boolean; period: { from: string; to: string } };

// Sector accents follow the PDF reference (grill amber, pizza red, drinks blue, desserts purple, then neutrals); assignment is stable by sector order.
const sectorAccents = ['border-l-amber-500', 'border-l-red-500', 'border-l-sky-500', 'border-l-purple-500', 'border-l-emerald-500', 'border-l-brand-500'];
const sectorDots = ['bg-amber-500', 'bg-red-500', 'bg-sky-500', 'bg-purple-500', 'bg-emerald-500', 'bg-brand-500'];

export default function KdsPage() {
  const [sectors, setSectors] = useState<ProductionSector[]>([]); const [sectorId, setSectorId] = useState(''); const [items, setItems] = useState<KdsItem[]>([]); const [stages, setStages] = useState<KdsStage[]>([]); const [canEdit, setCanEdit] = useState(false);
  const [message, setMessage] = useState(''); const [now, setNow] = useState(0); const [updatedAt, setUpdatedAt] = useState('');
  const [readyOrders, setReadyOrders] = useState<{ id: string; label: string }[]>([]); const [history, setHistory] = useState<History | null>(null);
  const inflight = useRef(false);

  async function loadItems(sector = sectorId) {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const data = await api<ListResponse<KdsItem> & { stages?: KdsStage[] }>(`/production/kds${sector ? `?sectorId=${sector}` : ''}`);
      setItems(data.items); if (data.stages) setStages(data.stages); setNow(Date.now()); setUpdatedAt(new Date().toLocaleTimeString('pt-BR')); setMessage('');
    } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar a cozinha')); } finally { inflight.current = false; }
  }
  async function loadSectors() {
    try { const data = await api<ListResponse<ProductionSector>>('/production/sectors'); setSectors(data.items.filter(sector => sector.active && sector.showOnKds)); } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar setores')); }
  }
  useAutoLoad(loadSectors);
  useEffect(() => { try { setCanEdit(['ADMIN', 'MANAGER'].includes(JSON.parse(localStorage.getItem(userStorageKey) ?? '{}').role)); } catch { setCanEdit(false); } }, []);
  useAutoLoad(() => loadItems(), 10000);

  async function advance(item: KdsItem, stage: string) {
    try {
      const result = await api<{ orderReady?: boolean }>(`/production/items/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      if (result.orderReady) setReadyOrders(current => [{ id: item.order.id, label: `${item.order.code}${item.order.tableLabel ? ` · Mesa ${item.order.tableLabel}` : ''}` }, ...current.filter(entry => entry.id !== item.order.id)].slice(0, 5));
      inflight.current = false; await loadItems();
    } catch (e) { setMessage(errorMessage(e, 'Erro ao atualizar item')); }
  }
  async function togglePriority(item: KdsItem) {
    try { await api(`/production/orders/${item.order.id}/priority`, { method: 'POST', body: JSON.stringify({ priority: !item.order.priority }) }); inflight.current = false; await loadItems(); } catch (e) { setMessage(errorMessage(e, 'Erro ao priorizar o pedido')); }
  }
  async function loadHistory() {
    try { setHistory(await api<History>(`/production/history${sectorId ? `?sectorId=${sectorId}` : ''}`)); } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar o histórico')); }
  }
  function changeSector(value: string) { setSectorId(value); inflight.current = false; setHistory(null); void loadItems(value); }
  // Neighbour stages in the restaurant's own flow: the primary button moves forward, the small one steps back (never before the first stage).
  const neighbour = (item: KdsItem, step: 1 | -1) => { const index = stages.findIndex(stage => stage.key === item.stage?.key); return index < 0 ? undefined : stages[index + step]; };
  const sectorIndex = (id?: string) => Math.max(0, sectors.findIndex(sector => sector.id === id));
  const minutes = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  // A sector's configured preparation time is its delay limit; sectors without one use 15 minutes.
  const limitOf = (item: KdsItem) => item.product.sector?.avgPrepMinutes ?? 15;
  const isLate = (item: KdsItem) => item.status !== 'READY' && minutes(item.createdAt) >= limitOf(item);

  const active = items.filter(item => item.status !== 'READY');
  const late = active.filter(isLate).length;
  const averageWait = active.length ? Math.round(active.reduce((sum, item) => sum + minutes(item.createdAt), 0) / active.length) : 0;
  const count = (status: KdsItem['status']) => items.filter(item => item.status === status).length;

  return <AppShell title="RM KDS — Painel de Produção">
    <PageHeader title="RM KDS — Painel de Produção" subtitle="Pedidos recebidos automaticamente, separados por setor, com cronômetro de preparo e indicador de atraso. Atualiza sozinho a cada 10 segundos." />
    <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard tone="dark" icon="🛎️" label="Recebidos" value={count('PENDING')} hint="Aguardando preparo" />
      <StatCard icon="🔥" label="Em preparo" value={count('PREPARING')} />
      <StatCard icon="✅" label="Prontos" value={count('READY')} hint="Aguardando entrega" />
      <StatCard tone={late > 0 ? 'dark' : 'default'} icon="⏱️" label="Atrasados (15 min+)" value={late} hint={late > 0 ? 'Priorize estes itens' : 'Nenhum atraso'} />
      <StatCard icon="🕒" label="Espera média" value={`${averageWait} min`} hint="Itens ainda não prontos" />
    </div>
    {message && <Notice message={message} />}
    {readyOrders.map(entry => <div key={entry.id} role="status" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900"><span>✅ Pedido {entry.label} pronto — avise o garçom / entregue ao cliente.</span><button type="button" className="text-xs underline" onClick={() => setReadyOrders(current => current.filter(other => other.id !== entry.id))}>Dispensar</button></div>)}
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div className="w-full max-w-xs"><Select label="Setor" value={sectorId} onChange={e => changeSector(e.target.value)}><option value="">Todos os setores</option>{sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</Select></div><ul aria-label="Legenda de setores" className="flex flex-wrap items-center gap-3 text-xs text-slate-600">{sectors.map((sector, index) => <li key={sector.id} className="flex items-center gap-1.5"><span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${sectorDots[index % sectorDots.length]}`} />{sector.name}</li>)}</ul><div className="flex items-center gap-3 text-xs text-slate-500"><span>Atualiza a cada 10 s{updatedAt ? ` · última às ${updatedAt}` : ''}</span><button className={secondaryButtonClass} onClick={() => void loadItems()}>Atualizar agora</button></div></div>
    <div className="grid gap-4 lg:grid-cols-3">{columns.map(column => {
      const list = items.filter(item => item.status === column.status).sort((a, b) => Number(Boolean(b.order.priority)) - Number(Boolean(a.order.priority)) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return <section key={column.status} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className={`px-4 py-3 text-center text-sm font-semibold text-white ${column.tone}`}>{column.label} ({list.length})</h2><div className="grid min-h-40 content-start gap-3 p-3">{list.map(item => <article key={item.id} className={`rounded-xl border border-l-4 p-4 ${isLate(item) ? 'border-red-300 bg-red-50' : item.order.priority ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50'} ${sectorAccents[sectorIndex(item.product.sector?.id) % sectorAccents.length]}`}><div className="flex items-start justify-between gap-2"><div><p className="text-lg font-semibold">{item.quantity}× {item.product.name}</p>{item.stage && <p data-testid="kds-stage" className="mt-0.5 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: item.stage.color }} />{item.stage.label}</p>}{item.modifiers && item.modifiers.length > 0 && <ul className="mt-1 text-sm text-slate-700">{item.modifiers.map(modifier => <li key={modifier.id}>+ {modifier.name} x{modifier.quantity}</li>)}</ul>}{item.parentItem && <p className="mt-1 text-sm text-purple-700">do combo: {item.parentItem.product.name}</p>}{item.notes && <p className="mt-1 text-sm text-amber-800">Obs.: {item.notes}</p>}<p className="mt-2 text-xs text-slate-600">{item.order.code} · {item.order.tableLabel ? `Mesa ${item.order.tableLabel}` : item.order.channel}{item.order.createdBy ? ` · Garçom: ${item.order.createdBy.name}` : ''}{item.product.sector ? ` · ${item.product.sector.name}` : ''}</p></div><div className="flex flex-col items-end gap-1"><span className={`rounded-full px-2 py-0.5 text-xs ${isLate(item) ? 'bg-red-600 font-semibold text-white' : 'bg-white text-slate-600'}`} title={`Limite do setor: ${limitOf(item)} min`}>{minutes(item.createdAt)} min</span><button type="button" aria-pressed={Boolean(item.order.priority)} aria-label={item.order.priority ? 'Remover prioridade do pedido' : 'Priorizar pedido'} title={item.order.priority ? 'Pedido priorizado' : 'Priorizar pedido'} className={`rounded-full px-2 py-0.5 text-sm ${item.order.priority ? 'bg-amber-400 text-neutral-950' : 'bg-white text-slate-500 hover:text-amber-600'}`} onClick={() => void togglePriority(item)}>★</button></div></div>{neighbour(item, 1) && <button className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-brand-400" onClick={() => void advance(item, neighbour(item, 1)!.key)}>{neighbour(item, 1)!.label}</button>}{column.status !== 'PENDING' && neighbour(item, -1) && <button className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100" onClick={() => void advance(item, neighbour(item, -1)!.key)}>Voltar: {neighbour(item, -1)!.label}</button>}</article>)}{list.length === 0 && <p className="py-4 text-center text-sm text-slate-500">Nenhum item.</p>}</div></section>;
    })}</div>
    {canEdit && stages.length > 0 && <KdsStagesEditor stages={stages} onSaved={next => { setStages(next); inflight.current = false; void loadItems(); }} />}
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Histórico de produção">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-bold">Histórico de produção (últimos 7 dias)</h2><button type="button" className={secondaryButtonClass} onClick={() => void loadHistory()}>{history ? 'Atualizar histórico' : 'Ver histórico'}</button></div>
      {history && (history.sectors.length === 0 ? <p className="mt-3 text-sm text-slate-500">Ainda não há itens finalizados no período.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="p-2">Setor</th><th className="p-2">Itens</th><th className="p-2">Preparo médio</th><th className="p-2">Espera média</th><th className="p-2">Tempo esperado</th><th className="p-2">Fora do prazo</th></tr></thead><tbody>{history.sectors.map(row => <tr key={row.sector} className="border-t border-slate-100"><td className="p-2 font-semibold">{row.sector}</td><td className="p-2">{row.items}</td><td className="p-2">{row.averagePrepMinutes} min</td><td className="p-2">{row.averageWaitMinutes} min</td><td className="p-2">{row.expectedMinutes === null ? '—' : `${row.expectedMinutes} min`}</td><td className="p-2">{row.latePercent === null ? '—' : `${row.late} (${row.latePercent}%)`}</td></tr>)}</tbody></table></div>)}
    </section>
  </AppShell>;
}
