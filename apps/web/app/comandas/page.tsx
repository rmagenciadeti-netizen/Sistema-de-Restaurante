'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { OpsNav } from '../../components/ops-nav';
import { Badge, EmptyState } from '../../components/ui';
import { elapsedLabel, isHeld, isTabOrder, opsError, orderTitle, paidTotal, type OpsOrder, type OpsTable } from '../../lib/types-ops';

type Tab = { key: string; label: string; tableId: string | null; orders: OpsOrder[]; total: number; paid: number };

async function loadTabOrders() {
  const items: OpsOrder[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await api<ListResponse<OpsOrder>>(`/orders?scope=active&table=1&pageSize=100&page=${page}`);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items;
}

export default function ComandasPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [tables, setTables] = useState<OpsTable[]>([]);
  const [search, setSearch] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(0);

  async function load() {
    try {
      const [tabOrders, tableList] = await Promise.all([
        loadTabOrders(),
        api<ListResponse<OpsTable>>('/tables').catch(error => { if (error instanceof ApiError && error.status === 403) return { items: [] as OpsTable[], total: 0 }; throw error; }),
      ]);
      setOrders(tabOrders); setTables(tableList.items.filter(table => table.active)); setNow(Date.now()); setMessage('');
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar comandas')); }
  }
  useAutoLoad(load, 20000);

  const groups = new Map<string, Tab>();
  for (const order of orders.filter(item => isTabOrder(item) && !isHeld(item))) {
    const label = order.tableLabel ?? 'Sem identificação';
    const key = order.tableId ? `table:${order.tableId}` : `tab:${label.toLocaleLowerCase('pt-BR')}`;
    const group = groups.get(key) ?? { key, label, tableId: order.tableId ?? null, orders: [], total: 0, paid: 0 };
    group.orders.push(order); group.total += Number(order.total); group.paid += Math.min(paidTotal(order), Number(order.total));
    groups.set(key, group);
  }
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const open = Array.from(groups.values()).filter(group => !term || group.label.toLocaleLowerCase('pt-BR').includes(term)).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
  const busyTableIds = new Set(Array.from(groups.values()).map(group => group.tableId).filter(Boolean));
  const freeTables = tables.filter(table => !busyTableIds.has(table.id) && (!term || table.label.toLocaleLowerCase('pt-BR').includes(term)));
  const openHref = (group: Tab) => group.tableId ? `/pdv?tableId=${encodeURIComponent(group.tableId)}` : `/pdv?tab=${encodeURIComponent(group.label)}`;

  function startTab(event: React.FormEvent) {
    event.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    router.push(`/pdv?tab=${encodeURIComponent(label)}`);
  }

  return <AppShell title="Controle de comandas">
    <OpsNav />
    {message && <Notice message={message} />}
    <section className={`${panelClass} mb-4`}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1"><Field label="Pesquisar comanda ou mesa" type="search" placeholder="Número, nome ou mesa" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <form onSubmit={startTab} className="flex min-w-56 flex-1 items-end gap-2">
          <div className="flex-1"><Field label="Nova comanda" maxLength={30} placeholder="Ex.: 12 ou Fulano" value={newLabel} onChange={event => setNewLabel(event.target.value)} /></div>
          <button className={`${buttonClass} min-h-11`} disabled={!newLabel.trim()}>Abrir</button>
        </form>
        <Link href="/history?channel=TABLE" className={`${secondaryButtonClass} flex min-h-11 items-center`}>Histórico de comandas</Link>
      </div>
    </section>

    {open.length === 0
      ? <EmptyState icon="🧾" title="Nenhuma comanda encontrada, deseja adicionar uma?" hint={term ? 'Nenhuma comanda aberta corresponde à pesquisa.' : 'As comandas e mesas com consumo em aberto aparecem aqui.'} action={<Link href={newLabel.trim() ? `/pdv?tab=${encodeURIComponent(newLabel.trim())}` : '/pdv'} className={buttonClass}>Adicionar</Link>} />
      : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {open.map(group => {
          const oldest = group.orders.reduce((min, order) => order.createdAt < min ? order.createdAt : min, group.orders[0].createdAt);
          const pending = group.total - group.paid;
          const firstUnpaid = group.orders.find(order => paidTotal(order) < Number(order.total));
          return <article key={group.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.tableId ? 'Mesa' : 'Comanda'}</p><h3 className="text-2xl font-black text-slate-900">{group.label}</h3></div>
              <Badge tone="gold">⏱ {elapsedLabel(oldest, now || undefined)}</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-600">{group.orders.length} pedido(s): {group.orders.map(orderTitle).join(', ')}</p>
            <div className="mt-3 flex items-end justify-between border-t border-slate-100 pt-3">
              <div><p className="text-[11px] uppercase tracking-wider text-slate-500">Total acumulado</p><p className="text-xl font-bold text-slate-900">{formatMoney(group.total)}</p></div>
              {group.paid > 0 && <p className="text-right text-xs text-slate-500">Pago {formatMoney(group.paid)}<br /><span className="font-semibold text-slate-800">Falta {formatMoney(pending)}</span></p>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={openHref(group)} className={`${buttonClass} flex min-h-11 flex-1 items-center justify-center`}>Adicionar</Link>
              {firstUnpaid && <Link href={`/cash?orderId=${encodeURIComponent(firstUnpaid.id)}#pagamento`} className={`${secondaryButtonClass} flex min-h-11 items-center`}>Cobrar</Link>}
              <Link href={`/history?channel=TABLE&q=${encodeURIComponent(group.label)}`} className={`${secondaryButtonClass} flex min-h-11 items-center`}>Pedidos</Link>
            </div>
          </article>;
        })}
      </div>}

    {tables.length > 0 && <section className="mt-6" aria-label="Mapa do salão">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Mapa do salão ({tables.length} mesas · {freeTables.length} livres)</h2>
        <ul className="flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Legenda">
          <li className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-emerald-500" />Livre</li>
          <li className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-red-500" />Ocupada</li>
          <li className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-amber-400" />Parcialmente paga</li>
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {tables.filter(table => !term || table.label.toLocaleLowerCase('pt-BR').includes(term)).map(table => {
          const group = groups.get(`table:${table.id}`);
          const partial = group !== undefined && group.paid > 0 && group.total - group.paid > 0.009;
          const tone = !group ? 'border-emerald-300 bg-emerald-50 hover:border-emerald-500' : partial ? 'border-amber-300 bg-amber-50 hover:border-amber-500' : 'border-red-300 bg-red-50 hover:border-red-500';
          const dot = !group ? 'bg-emerald-500' : partial ? 'bg-amber-400' : 'bg-red-500';
          const oldest = group?.orders.reduce((min, order) => order.createdAt < min ? order.createdAt : min, group.orders[0].createdAt);
          return <Link key={table.id} href={group ? openHref(group) : `/pdv?tableId=${encodeURIComponent(table.id)}`} aria-label={`Mesa ${table.label}: ${group ? (partial ? 'parcialmente paga' : 'ocupada') : 'livre'}`} className={`relative flex min-h-28 flex-col justify-between rounded-2xl border-2 p-3 transition ${tone}`}>
            <span className={`absolute right-3 top-3 h-3 w-3 rounded-full ${dot}`} />
            <span><span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Mesa</span><span className="block text-2xl font-black text-slate-900">{table.label}</span></span>
            {group && oldest
              ? <span className="text-xs text-slate-700"><strong className="block text-sm text-slate-900">{formatMoney(group.total - group.paid)}</strong>{group.orders.length} pedido(s) · ⏱ {elapsedLabel(oldest, now || undefined)}</span>
              : <span className="text-xs text-slate-500">{table.seats} lugares · toque para abrir</span>}
          </Link>;
        })}
      </div>
    </section>}
  </AppShell>;
}
