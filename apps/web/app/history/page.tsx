'use client';

import { Fragment, useRef, useState } from 'react';
import { api, formatDateTime, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, inputClass, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { OpsNav } from '../../components/ops-nav';
import { OrderReceipt } from '../../components/order-receipt';
import { Badge, DataTable, EmptyState } from '../../components/ui';
import { channelLabels, lineWeight, methodLabels, opsError, orderTitle, paidTotal, statusLabels, type OpsOrder } from '../../lib/types-ops';

const PAGE_SIZE = 25;
const statusTone = { OPEN: 'blue', PREPARING: 'amber', READY: 'green', COMPLETED: 'neutral', CANCELLED: 'red' } as const;

type Filters = { q: string; channel: string; status: string; from: string; to: string };
const emptyFilters: Filters = { q: '', channel: '', status: '', from: '', to: '' };

function query(filters: Filters, page: number) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999`).toISOString());
  return params.toString();
}

export default function HistoryPage() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState('');
  const [printing, setPrinting] = useState<OpsOrder | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const initial = useRef(true);

  async function load(nextPage = page, active = filters) {
    setLoading(true);
    try {
      const result = await api<ListResponse<OpsOrder>>(`/orders?${query(active, nextPage)}`);
      setOrders(result.items); setTotal(result.total); setPage(nextPage); setMessage('');
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar o histórico')); }
    finally { setLoading(false); }
  }
  useAutoLoad(async () => {
    if (!initial.current) return;
    initial.current = false;
    const params = new URLSearchParams(window.location.search);
    const fromUrl: Filters = { ...emptyFilters, channel: params.get('channel') ?? '', q: params.get('q') ?? '', status: params.get('status') ?? '' };
    setFilters(fromUrl);
    await load(1, fromUrl);
  });

  function submit(event: React.FormEvent) { event.preventDefault(); void load(1); }
  function clear() { setFilters(emptyFilters); void load(1, emptyFilters); }
  function print(order: OpsOrder) { setPrinting(order); setTimeout(() => window.print(), 80); }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tabsView = filters.channel === 'TABLE';

  return <AppShell title={tabsView ? 'Histórico de comandas' : 'Histórico de vendas'}>
    <div className="print:hidden">
      <OpsNav />
      {message && <Notice message={message} />}
      <form onSubmit={submit} className={`${panelClass} mb-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-6`}>
        <div className="sm:col-span-2"><Field label="Buscar" type="search" placeholder="Nº, código, cliente ou mesa" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></div>
        <label className="block text-sm text-slate-700">Canal<select className={inputClass} value={filters.channel} onChange={event => setFilters({ ...filters, channel: event.target.value })}><option value="">Todos</option>{Object.entries(channelLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="block text-sm text-slate-700">Status<select className={inputClass} value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">Todos</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <Field label="De" type="date" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} />
        <Field label="Até" type="date" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-6"><button className={`${buttonClass} min-h-11`} disabled={loading}>{loading ? 'Buscando…' : 'Filtrar'}</button><button type="button" className={`${secondaryButtonClass} min-h-11`} onClick={clear}>Limpar</button></div>
      </form>

      {orders.length === 0 && !loading
        ? <EmptyState icon="🗂️" title="Nenhum pedido encontrado" hint="Ajuste os filtros ou o período da busca." />
        : <DataTable columns={[{ label: 'Nº' }, { label: 'Data' }, { label: 'Cliente / mesa' }, { label: 'Canal' }, { label: 'Itens' }, { label: 'Pagamento' }, { label: 'Total', className: 'text-right' }, { label: 'Status' }, { label: 'Ações', className: 'text-right' }]} footer={`${total} pedido(s) · página ${page} de ${pages}`}>
          {orders.map(order => {
            const paid = paidTotal(order);
            const open = expanded === order.id;
            const discount = Number(order.discount ?? 0);
            return <Fragment key={order.id}>
              <tr>
                <td className="font-bold text-slate-900">{orderTitle(order)}<span className="block text-[11px] font-normal text-slate-500">{order.code}</span></td>
                <td className="whitespace-nowrap text-slate-600">{formatDateTime(order.createdAt)}</td>
                <td>{order.tableLabel ? `Mesa/comanda ${order.tableLabel}` : order.customerName || order.customer?.name || '—'}</td>
                <td>{channelLabels[order.channel] ?? order.channel}</td>
                <td>{order.items.filter(item => !item.parentItemId).reduce((sum, item) => sum + Number(item.quantity), 0)}</td>
                <td>{paid <= 0 ? <Badge>Pendente</Badge> : paid >= Number(order.total) ? <Badge tone="green">{formatMoney(paid)}</Badge> : <Badge tone="amber">Parcial {formatMoney(paid)}</Badge>}</td>
                <td className="text-right font-semibold">{formatMoney(order.total)}</td>
                <td><Badge tone={statusTone[order.status as keyof typeof statusTone] ?? 'neutral'}>{statusLabels[order.status] ?? order.status}</Badge></td>
                <td className="whitespace-nowrap text-right"><button type="button" aria-expanded={open} className={`${secondaryButtonClass} mr-1`} onClick={() => setExpanded(open ? '' : order.id)}>{open ? 'Ocultar' : 'Detalhes'}</button><button type="button" className={secondaryButtonClass} onClick={() => print(order)}>Imprimir</button></td>
              </tr>
              {open && <tr className="bg-slate-50"><td colSpan={9}>
                <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
                  <ul className="space-y-1 text-sm">
                    {order.items.filter(item => !item.parentItemId).map(item => <li key={item.id} className="flex justify-between gap-3"><span>{item.quantity}× {item.product.name}{lineWeight(item) ? <span className="text-slate-500"> · {lineWeight(item)}</span> : null}{item.modifiers?.length ? <span className="block text-xs text-slate-500">{item.modifiers.map(modifier => `+ ${modifier.quantity}× ${modifier.name}`).join(', ')}</span> : null}{item.notes ? <span className="block text-xs text-amber-700">Obs.: {item.notes}</span> : null}</span><span className="font-medium">{formatMoney(item.total)}</span></li>)}
                  </ul>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Sub-total</dt><dd>{formatMoney(order.subtotal)}</dd></div>
                    {discount !== 0 && <div className="flex justify-between"><dt className="text-slate-500">{discount > 0 ? 'Desconto' : 'Acréscimo'}</dt><dd>{discount > 0 ? '- ' : ''}{formatMoney(Math.abs(discount))}</dd></div>}
                    {Number(order.serviceFee ?? 0) > 0 && <div className="flex justify-between"><dt className="text-slate-500">Taxa de serviço</dt><dd>{formatMoney(order.serviceFee)}</dd></div>}
                    {Number(order.couvertFee ?? 0) > 0 && <div className="flex justify-between"><dt className="text-slate-500">Couvert</dt><dd>{formatMoney(order.couvertFee)}</dd></div>}
                    {Number(order.deliveryFee ?? 0) > 0 && <div className="flex justify-between"><dt className="text-slate-500">Entrega</dt><dd>{formatMoney(order.deliveryFee)}</dd></div>}
                    <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><dt>Total</dt><dd>{formatMoney(order.total)}</dd></div>
                    {(order.payments ?? []).map(payment => <div key={payment.id} className="flex justify-between text-emerald-700"><dt>{methodLabels[payment.method] ?? payment.method}</dt><dd>{formatMoney(payment.amount)}</dd></div>)}
                    {order.scheduledFor && <p className="pt-1 text-xs text-amber-700">Agendado para {formatDateTime(order.scheduledFor)}</p>}
                  </dl>
                </div>
              </td></tr>}
            </Fragment>;
          })}
        </DataTable>}

      <div className="mt-4 flex items-center justify-between">
        <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>‹ Anterior</button>
        <span className="text-sm text-slate-500">Página {page} de {pages}</span>
        <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={page >= pages || loading} onClick={() => void load(page + 1)}>Próxima ›</button>
      </div>
    </div>
    {printing && <OrderReceipt order={printing} />}
  </AppShell>;
}
