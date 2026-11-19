'use client';

import Link from '../../components/nav-link';
import { useState } from 'react';
import { api, ApiError, formatDateTime, formatMoney, ListResponse, storedUser } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Notice, secondaryButtonClass } from '../../components/app-shell';
import { OpsNav } from '../../components/ops-nav';
import { OrderEditDialog } from '../../components/order-edit-dialog';
import { OrderReceipt, PickupTicket, pickupTicketItems } from '../../components/order-receipt';
import { PasswordReleaseDialog } from '../../components/password-release';
import { Badge, EmptyState } from '../../components/ui';
import { channelLabels, elapsedLabel, isHeld, lineText, opsError, orderTitle, paidTotal, type OpsOrder } from '../../lib/types-ops';
import type { Courier } from '../../lib/types-registry';
import type { SettingsResponse, TenantSettings } from '../../lib/settings';

type Column = 'ACCEPTED' | 'READY' | 'OUT';
type Filter = 'ALL' | 'LOCAL' | 'DELIVERY';

const columns: { key: Column; title: string; hint: string; bar: string; head: string }[] = [
  { key: 'ACCEPTED', title: 'Aceito', hint: 'Na fila ou em preparo', bar: 'border-sky-500', head: 'bg-sky-600' },
  { key: 'READY', title: 'Pronto', hint: 'Aguardando retirada ou despacho', bar: 'border-emerald-500', head: 'bg-emerald-600' },
  { key: 'OUT', title: 'Saiu para entrega', hint: 'Entregador em rota', bar: 'border-brand-500', head: 'bg-brand-600' },
];
const filters: { key: Filter; label: string }[] = [{ key: 'ALL', label: 'Todos' }, { key: 'LOCAL', label: 'Retirada / Consumo' }, { key: 'DELIVERY', label: 'Entrega' }];

// A delivery order leaves the counter when its delivery job is picked up by the courier.
function columnOf(order: OpsOrder): Column {
  if (order.channel === 'DELIVERY' && order.deliveryJob?.status === 'PICKED_UP' && order.status === 'READY') return 'OUT';
  return order.status === 'READY' ? 'READY' : 'ACCEPTED';
}

async function loadActive() {
  const items: OpsOrder[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await api<ListResponse<OpsOrder>>(`/orders?scope=active&pageSize=100&page=${page}`);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items;
}

export default function MonitorPage() {
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');
  const [busyId, setBusyId] = useState('');
  const [cancelTarget, setCancelTarget] = useState<OpsOrder | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [now, setNow] = useState(0);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  // null: the profile cannot issue fiscal documents (hides the NFC-e button); []: no provider configured.
  const [fiscalProviders, setFiscalProviders] = useState<string[] | null>(null);
  const [courierPick, setCourierPick] = useState<Record<string, string>>({});
  const [manualCourier, setManualCourier] = useState<Record<string, string>>({});
  const [menuId, setMenuId] = useState('');
  const [editing, setEditing] = useState<OpsOrder | null>(null);
  const [printing, setPrinting] = useState<OpsOrder | null>(null);
  const [printKind, setPrintKind] = useState<'receipt' | 'ticket'>('receipt');
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');

  async function load() {
    try {
      const [active, courierList, providers] = await Promise.all([
        loadActive(),
        api<ListResponse<Courier>>('/couriers?active=true').catch(() => ({ items: [] as Courier[] })),
        api<{ items: string[] }>('/fiscal/providers').catch(() => null),
        api<SettingsResponse>('/settings').then(result => {
          setSettings(result.settings); setSettingsError('');
        }).catch(error => {
          setSettings(null); setSettingsError(opsError(error, 'Erro ao carregar configurações de impressão'));
        }),
      ]);
      setOrders(active); setCouriers(courierList.items); setFiscalProviders(providers?.items ?? null);
      setUpdatedAt(new Date().toISOString()); setNow(Date.now()); setMessage('');
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar pedidos')); }
  }
  useAutoLoad(load, 15000);

  async function changeStatus(order: OpsOrder, status: string, afterDelivered = false) {
    setBusyId(order.id); setMessage(''); setSuccess('');
    try {
      if (afterDelivered && order.deliveryJob) await api(`/delivery/${order.deliveryJob.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'DELIVERED' }) }).catch(() => undefined);
      await api(`/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setSuccess(`Pedido ${orderTitle(order)} atualizado.`);
      await load();
    } catch (error) { setMessage(opsError(error, 'Erro ao atualizar pedido')); }
    finally { setBusyId(''); }
  }
  function requestCancel(order: OpsOrder) {
    const role = storedUser().role;
    if (role === 'ADMIN' || role === 'MANAGER') { if (window.confirm(`Cancelar o pedido ${orderTitle(order)}?`)) void changeStatus(order, 'CANCELLED'); return; }
    setCancelTarget(order);
  }

  const MANUAL = '__manual__';
  const courierChoice = (order: OpsOrder) => courierPick[order.id] ?? order.deliveryJob?.courierId ?? (couriers.length === 0 || (order.deliveryJob?.courierName && !order.deliveryJob.courierId) ? MANUAL : '');
  async function dispatch(order: OpsOrder) {
    const choice = courierChoice(order);
    const manualName = (manualCourier[order.id] ?? order.deliveryJob?.courierName ?? '').trim();
    if (!choice || (choice === MANUAL && !manualName)) { setMessage('Escolha o entregador antes de enviar o pedido.'); return; }
    setBusyId(order.id); setMessage(''); setSuccess('');
    try {
      await api(`/delivery/orders/${order.id}/dispatch`, { method: 'POST', body: JSON.stringify(choice === MANUAL ? { courierName: manualName } : { courierId: choice }) });
      setSuccess(`Pedido ${orderTitle(order)} saiu para entrega.`);
      await load();
    } catch (error) { setMessage(opsError(error, 'Erro ao enviar o pedido para entrega')); }
    finally { setBusyId(''); }
  }
  function print(order: OpsOrder, kind: 'receipt' | 'ticket' = 'receipt') { setPrintKind(kind); setPrinting(order); setTimeout(() => window.print(), 80); }
  async function emitNfce(order: OpsOrder) {
    if (!fiscalProviders?.length) { setMessage('Nenhum provedor fiscal configurado: a NFC-e não pode ser emitida. Veja Integrações › PIX, POS e fiscal.'); return; }
    if (!window.confirm(`Gerar a NFC-e do pedido ${orderTitle(order)}? A numeração e a tributação seguem as configurações fiscais do sistema.`)) return;
    setBusyId(order.id); setMessage(''); setSuccess('');
    try {
      const document = await api<{ number?: string | null; series?: string | null }>(`/fiscal/orders/${order.id}/emit`, { method: 'POST', body: JSON.stringify({ provider: fiscalProviders[0], kind: 'NFCE' }) });
      setSuccess(`NFC-e do pedido ${orderTitle(order)} autorizada${document.number ? ` (nº ${document.number}${document.series ? `, série ${document.series}` : ''})` : ''}.`);
      await load();
    } catch (error) { setMessage(error instanceof ApiError && error.status === 422 ? `NFC-e rejeitada: ${error.message}` : opsError(error, 'Erro ao gerar NFC-e')); await load(); }
    finally { setBusyId(''); }
  }

  const visible = orders.filter(order => !isHeld(order) && (filter === 'ALL' || (filter === 'DELIVERY' ? order.channel === 'DELIVERY' : order.channel !== 'DELIVERY')));
  const counts: Record<Filter, number> = { ALL: orders.filter(order => !isHeld(order)).length, LOCAL: orders.filter(order => !isHeld(order) && order.channel !== 'DELIVERY').length, DELIVERY: orders.filter(order => !isHeld(order) && order.channel === 'DELIVERY').length };

  function actions(order: OpsOrder, column: Column) {
    const busy = busyId === order.id;
    const dispatching = order.channel === 'DELIVERY' && column === 'READY';
    const advance = (status: string, text: string) => <button type="button" disabled={busy} onClick={() => void changeStatus(order, status)} className={`${buttonClass} min-h-11 flex-1`}>{text}</button>;
    const main = column === 'OUT'
      ? <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'COMPLETED', true)} className={`${buttonClass} min-h-11 flex-1`}>Confirmar entrega</button>
      : dispatching ? <button type="button" disabled={busy} onClick={() => void dispatch(order)} className={`${buttonClass} min-h-11 flex-1`}>Saiu para entrega</button>
        : order.status === 'OPEN' ? advance('PREPARING', 'Iniciar preparo')
          : order.status === 'PREPARING' ? advance('READY', 'Marcar pronto')
            : advance('COMPLETED', 'Entregar / finalizar');
    const choice = courierChoice(order);
    return <div className="mt-3">
      {dispatching && <div className="mb-2 grid gap-2">
        <label className="block text-xs font-semibold text-slate-600">Entregador
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" value={choice} disabled={busy} onChange={e => setCourierPick(current => ({ ...current, [order.id]: e.target.value }))}>
            <option value="">Selecione o entregador</option>
            {couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}{courier.phone ? ` — ${courier.phone}` : ''}</option>)}
            <option value={MANUAL}>Digitar nome…</option>
          </select>
        </label>
        {choice === MANUAL && <input aria-label="Nome do entregador" placeholder="Nome do entregador" maxLength={160} className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" value={manualCourier[order.id] ?? order.deliveryJob?.courierName ?? ''} onChange={e => setManualCourier(current => ({ ...current, [order.id]: e.target.value }))} />}
      </div>}
      <div className="flex flex-wrap gap-2">
        {main}
        {dispatching && <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'COMPLETED')} className={`${secondaryButtonClass} min-h-11`}>Finalizar</button>}
        <button type="button" disabled={busy} onClick={() => requestCancel(order)} className="min-h-11 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50">Cancelar</button>
      </div>
    </div>;
  }

  function nfceControl(order: OpsOrder) {
    if (fiscalProviders === null) return null;
    const document = order.fiscalDocuments?.[0];
    if (document?.status === 'AUTHORIZED') return <span className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 text-xs font-semibold text-emerald-700" title="NFC-e autorizada">{document.documentUrl ? <a href={document.documentUrl} target="_blank" rel="noreferrer">NFC-e nº {document.number}</a> : <>NFC-e nº {document.number}</>}</span>;
    if (document?.status === 'PENDING') return <span className="inline-flex min-h-9 items-center rounded-lg border border-amber-200 bg-amber-50 px-2 text-xs font-semibold text-amber-700">NFC-e em emissão…</span>;
    return <button type="button" disabled={busyId === order.id} onClick={() => void emitNfce(order)} className={`${secondaryButtonClass} min-h-9 !px-3 !py-1 text-xs`}>Gerar NFC-e</button>;
  }

  return <AppShell title="Pedidos">
    <div className="print:hidden">
    <OpsNav />
    {message && <Notice message={message} />}
    {settingsError && <Notice message={settingsError} />}
    {success && <Notice message={success} kind="success" />}
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
      <span>Atualiza sozinho a cada 15 segundos{updatedAt ? ` · última leitura ${formatDateTime(updatedAt)}` : ''}</span>
      <Link href="/scheduled" className="font-semibold text-brand-700 hover:text-brand-600">Pedidos agendados retidos aparecem em Vendas agendadas ›</Link>
    </div>
    <div className="grid items-start gap-4 pb-24 lg:grid-cols-3">
      {columns.map(column => {
        const list = visible.filter(order => columnOf(order) === column.key);
        return <section key={column.key} aria-label={column.title} className={`overflow-hidden rounded-2xl border-t-4 bg-white shadow-sm ring-1 ring-slate-200 ${column.bar}`}>
          <header className={`flex items-center justify-between gap-2 px-4 py-3 text-white ${column.head}`}>
            <div><h2 className="text-base font-bold">{column.title}</h2><p className="text-[11px] text-white/80">{column.hint}</p></div>
            <span className="grid h-8 min-w-8 place-items-center rounded-full bg-white/20 px-2 text-sm font-bold">{list.length}</span>
          </header>
          <div className="grid max-h-[70vh] gap-3 overflow-y-auto bg-slate-50 p-3">
            {list.map(order => <article key={order.id} className="relative rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><h3 className="text-2xl font-black tracking-tight text-slate-900">{orderTitle(order)}</h3><p className="truncate text-[11px] text-slate-500">{order.code}</p></div>
                <div className="flex items-start gap-1">
                  <div className="flex flex-wrap justify-end gap-1"><Badge tone={order.channel === 'DELIVERY' ? 'gold' : 'blue'}>{channelLabels[order.channel] ?? order.channel}</Badge>{order.scheduledFor && <Badge tone="amber">Agendado {new Date(order.scheduledFor).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Badge>}</div>
                  <div className="relative">
                    <button type="button" aria-label={`Mais opções do pedido ${orderTitle(order)}`} aria-haspopup="menu" aria-expanded={menuId === order.id} onClick={() => setMenuId(menuId === order.id ? '' : order.id)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>
                    </button>
                    {menuId === order.id && <>
                      <button type="button" aria-label="Fechar menu" tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuId('')} />
                      <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg">
                        <button type="button" role="menuitem" className="block w-full px-3 py-2 text-left text-slate-700 hover:bg-brand-50" onClick={() => { setMenuId(''); setEditing(order); }}>✏️ Editar pedido</button>
                      </div>
                    </>}
                  </div>
                </div>
              </div>
              <p className="mt-1 text-sm font-medium text-slate-700">{order.tableLabel ? `Mesa/comanda ${order.tableLabel}` : order.customerName || order.customer?.name || 'Sem cliente informado'}{order.tableLabel && order.customerName ? ` · ${order.customerName}` : ''}</p>
              <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
                {order.items.filter(item => !item.parentItemId).slice(0, 6).map(item => <li key={item.id}>{lineText(item)}{item.notes ? <span className="block text-xs text-amber-700">Obs.: {item.notes}</span> : null}</li>)}
                {order.items.filter(item => !item.parentItemId).length > 6 && <li className="text-xs text-slate-500">+ {order.items.filter(item => !item.parentItemId).length - 6} itens</li>}
              </ul>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-sm">
                <span className="font-bold text-slate-900">{formatMoney(order.total)}</span>
                <span className="flex items-center gap-2">{paidTotal(order) >= Number(order.total) ? <Badge tone="green">Pago</Badge> : <Badge>A receber</Badge>}<span title={`Aberto em ${formatDateTime(order.createdAt)}`} className="text-xs font-semibold text-slate-500">⏱ {elapsedLabel(order.createdAt, now || undefined)}</span></span>
              </div>
              {order.deliveryJob?.courierName && <p className="mt-1 text-xs text-slate-500">Entregador: {order.deliveryJob.courierName}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <button type="button" aria-label={`Imprimir pedido ${orderTitle(order)}`} title="Imprimir pedido" onClick={() => print(order)} className={`${secondaryButtonClass} grid min-h-9 min-w-9 place-items-center !p-1.5`}>
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><rect x="7" y="14" width="10" height="7" rx="1" /></svg>
                </button>
                {settings?.ticket.enabled && pickupTicketItems(order).length > 0 && <button type="button" onClick={() => print(order, 'ticket')} className={`${secondaryButtonClass} min-h-9 !px-3 !py-1 text-xs`}>Ticket de retirada</button>}
                {nfceControl(order)}
              </div>
              {actions(order, column.key)}
            </article>)}
            {list.length === 0 && <EmptyState icon="✅" title="Nada por aqui" hint="Os pedidos aparecem automaticamente nesta coluna." />}
          </div>
        </section>;
      })}
    </div>
    <div role="group" aria-label="Filtrar pedidos" className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full bg-neutral-950 p-1.5 shadow-xl ring-1 ring-white/10 print:hidden">
      {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={`min-h-11 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${filter === item.key ? 'bg-brand-500 text-neutral-950' : 'text-neutral-200 hover:bg-white/10'}`}>{item.label} <span className="ml-1 opacity-70">{counts[item.key]}</span></button>)}
    </div>
    </div>
    {editing && <OrderEditDialog order={editing} onClose={() => setEditing(null)} onSaved={text => { setEditing(null); setSuccess(text); void load(); }} />}
    {printing && (printKind === 'ticket' ? <PickupTicket order={printing} printing={settings?.printing} /> : <OrderReceipt order={printing} printing={settings?.printing} company={settings?.company} />)}
    <PasswordReleaseDialog open={Boolean(cancelTarget)} action="CANCEL_ORDER" orderId={cancelTarget?.id} onCancel={() => setCancelTarget(null)} onAuthorized={() => { const target = cancelTarget; setCancelTarget(null); if (target) void changeStatus(target, 'CANCELLED'); }} />
  </AppShell>;
}
