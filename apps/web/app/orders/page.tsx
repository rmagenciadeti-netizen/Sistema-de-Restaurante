'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, ApiError, DeliveryZone, errorMessage, formatMoney, ListResponse, ModifierGroup, Order, Product, ProductComposition, RestaurantTable, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { ModifierPicker, ModifierSelection, modifiersPayload, selectionError } from '../../components/modifier-picker';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const nextOrderStatuses: Record<string, string[]> = {
  OPEN: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]); const [products, setProducts] = useState<Product[]>([]); const [message, setMessage] = useState(''); const [productId, setProductId] = useState(''); const [quantity, setQuantity] = useState(1); const [channel, setChannel] = useState('POS'); const [tableLabel, setTableLabel] = useState(''); const [customerName, setCustomerName] = useState(''); const [busy, setBusy] = useState(false); const [tables, setTables] = useState<RestaurantTable[]>([]); const [zones, setZones] = useState<DeliveryZone[]>([]); const [tableId, setTableId] = useState(''); const [zoneId, setZoneId] = useState(''); const [customerPhone, setCustomerPhone] = useState(''); const [marketingConsent, setMarketingConsent] = useState(false); const [couponCode, setCouponCode] = useState(''); const [applyServiceFee, setApplyServiceFee] = useState(true); const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]); const [compositions, setCompositions] = useState<Record<string, ProductComposition>>({}); const [modSel, setModSel] = useState<ModifierSelection>({});
  const [units, setUnits] = useState<Unit[]>([]); const [unitId, setUnitId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const tableLinkHandled = useRef(false);
  async function load() { try { const optional = <T,>(path: string) => api<ListResponse<T>>(path).catch(error => { if (error instanceof ApiError && error.status === 403) return { items: [] as T[], total: 0 }; throw error; }); const [result, catalog, tableList, zoneList, groupList, unitList] = await Promise.all([api<ListResponse<Order>>('/orders'), api<ListResponse<Product>>('/products'), optional<RestaurantTable>('/tables'), optional<DeliveryZone>('/delivery/zones'), optional<ModifierGroup>('/catalog/modifier-groups'), api<ListResponse<Unit>>('/units')]); setOrders(result.items); setTables(tableList.items.filter(table => table.active)); setZones(zoneList.items); setModifierGroups(groupList.items); setProducts(catalog.items.filter(product => product.active)); const activeUnits = unitList.items.filter(unit => unit.status === 'ACTIVE'); setUnits(activeUnits); setUnitId(current => current || (activeUnits.length === 1 ? activeUnits[0].id : ''));
    if (!tableLinkHandled.current) {
      tableLinkHandled.current = true;
      const requestedTable = new URLSearchParams(window.location.search).get('tableId');
      if (requestedTable) {
        const table = tableList.items.find(item => item.id === requestedTable && item.active && activeUnits.some(unit => unit.id === item.unitId));
        if (table) { setChannel('TABLE'); setUnitId(table.unitId); setTableId(table.id); }
        else setMessage('Mesa indisponível ou sem acesso. Selecione outra mesa para abrir o pedido.');
      }
    }
    const firstActive = catalog.items.find(product => product.active);
    if (!productId && firstActive) void chooseProduct(firstActive.id); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao carregar PDV'); } }
  useAutoLoad(load);
  async function chooseProduct(id: string) {
    setProductId(id); setModSel({});
    if (!id || compositions[id]) return;
    try { const data = await api<ProductComposition>(`/catalog/products/${id}/composition`); setCompositions(current => ({ ...current, [id]: data })); } catch (error) { if (!(error instanceof ApiError && error.status === 403)) setMessage(errorMessage(error, 'Erro ao carregar composição do produto')); }
  }
  const composition = compositions[productId];
  const productGroups = modifierGroups.filter(group => group.active && composition?.modifierGroups.some(link => link.groupId === group.id)).map(group => ({ ...group, options: group.options.filter(option => option.active !== false) }));
  const unitTables = tables.filter(table => table.unitId === unitId);
  const search = productSearch.trim().toLocaleLowerCase('pt-BR');
  const filteredProducts = products.filter(product => `${product.name} ${product.code ?? ''}`.toLocaleLowerCase('pt-BR').includes(search));
  async function createOrder(event: React.FormEvent) { event.preventDefault(); if (!productId) { setMessage('Cadastre ou selecione um produto antes de abrir o pedido.'); return; } if (channel === 'TABLE' && !unitId) { setMessage('Selecione a unidade do pedido de mesa.'); return; } const modifierError = selectionError(productGroups, modSel); if (modifierError) { setMessage(modifierError); return; } setBusy(true); setMessage(''); try { await api('/orders', { method: 'POST', body: JSON.stringify({ channel, unitId: channel === 'TABLE' ? unitId : undefined, customerName: customerName || undefined, customerPhone: customerName && customerPhone ? customerPhone : undefined, marketingConsent: customerName ? marketingConsent : undefined, tableId: channel === 'TABLE' && tableId ? tableId : undefined, tableLabel: channel === 'TABLE' && !tableId ? tableLabel || undefined : undefined, deliveryZoneId: channel === 'DELIVERY' && zoneId ? zoneId : undefined, couponCode: couponCode.trim() || undefined, applyServiceFee: channel === 'TABLE' ? applyServiceFee : undefined, items: [{ productId, quantity, modifiers: modifiersPayload(modSel) }] }) }); setMessage('Pedido criado e encaminhado ao fluxo de produção.'); setCustomerName(''); setCustomerPhone(''); setMarketingConsent(false); setCouponCode(''); setApplyServiceFee(true); setTableLabel(''); setTableId(''); setZoneId(''); setQuantity(1); setModSel({}); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao criar pedido'); } finally { setBusy(false); } }
  async function updateStatus(order: Order, status: string) { try { await api(`/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao atualizar pedido'); } }
  async function reprint(order: Order) { try { await api(`/printing/orders/${order.id}/print`, { method: 'POST' }); setMessage(`Produção do pedido ${order.code} reenviada para impressão.`); } catch (e) { setMessage(errorMessage(e, 'Erro ao reimprimir produção')); } }
  return <AppShell title="Pedidos e PDV">
    {message && <Notice message={message} kind={message.includes('criado') || message.includes('reenviada') ? 'success' : 'error'} />}
    <div className="mb-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(22rem,1fr)]">
      <section className={panelClass}>
        <div className="mb-4"><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Atendimento</p><h2 className="mt-1 text-lg font-semibold">Selecionar produto</h2></div>
        <Field label="Buscar produtos" type="search" placeholder="Nome ou código" value={productSearch} onChange={event => setProductSearch(event.target.value)} />
        <div className="mt-4 grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2">
          {filteredProducts.map(product => <button key={product.id} type="button" aria-pressed={product.id === productId} onClick={() => void chooseProduct(product.id)} className={`rounded-xl border p-4 text-left transition ${product.id === productId ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:border-brand-400'}`}><span className="block font-semibold text-slate-900">{product.name}</span><span className="mt-1 block text-xs text-slate-500">{product.code || product.sector?.name || 'Produto'}</span><span className="mt-2 block text-sm font-bold text-brand-700">{formatMoney(product.price)}</span></button>)}
          {filteredProducts.length === 0 && <p className="py-3 text-sm text-slate-500">{products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto ativo disponível.'}</p>}
        </div>
      </section>
      <section className={panelClass}>
      <h2 className="mb-4 text-lg font-semibold">Abrir pedido</h2>
      <form onSubmit={createOrder} className="grid gap-4 md:grid-cols-2">
        <label className="text-sm text-slate-300">Canal
          <select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={channel} onChange={e => setChannel(e.target.value)}>
            <option value="POS">PDV</option><option value="TABLE">Mesa / comanda</option><option value="DELIVERY">Delivery</option><option value="TAKEAWAY">Retirada</option><option value="WHATSAPP">WhatsApp</option>
          </select>
        </label>
        <label className="text-sm text-slate-300">Produto
          <select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={productId} onChange={e => void chooseProduct(e.target.value)}>
            <option value="">Selecione</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} — R$ {Number(product.price).toFixed(2)}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300">Quantidade<input type="number" min="1" max="999" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
        {channel === 'TABLE' && <Select label="Unidade" required value={unitId} onChange={e => { setUnitId(e.target.value); setTableId(''); setTableLabel(''); }}>
          <option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
        </Select>}
        {channel === 'TABLE' && unitId && (unitTables.length > 0
          ? <Select label="Mesa" value={tableId} onChange={e => setTableId(e.target.value)}><option value="">Selecione</option>{unitTables.map(table => <option key={table.id} value={table.id}>Mesa {table.label} ({table.seats} lugares)</option>)}</Select>
          : <Field label="Mesa / comanda" value={tableLabel} onChange={e => setTableLabel(e.target.value)} />)}
        {channel === 'DELIVERY' && <Select label="Zona de entrega" value={zoneId} onChange={e => setZoneId(e.target.value)}><option value="">Selecione</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name} — {formatMoney(zone.fee)}</option>)}</Select>}
        <Field label="Cliente" maxLength={160} value={customerName} onChange={e => setCustomerName(e.target.value)} />
        <Field label="Telefone do cliente" maxLength={30} value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
        <Field label="Cupom" maxLength={40} value={couponCode} onChange={e => setCouponCode(e.target.value)} />
        <div className="flex flex-col justify-end gap-2">
          {channel === 'TABLE' && <Check label="Cobrar taxa de serviço" checked={applyServiceFee} onChange={e => setApplyServiceFee(e.target.checked)} />}
          <Check label="Cliente consentiu marketing (LGPD)" checked={marketingConsent} disabled={!customerName} onChange={e => setMarketingConsent(e.target.checked)} />
        </div>
        {composition?.isCombo && <p className="text-sm text-blue-300 md:col-span-2">Combo: {composition.comboComponents.map(component => `${component.quantity}× ${component.product.name}`).join(', ')}</p>}
        {productGroups.length > 0 && <div className="md:col-span-2"><ModifierPicker groups={productGroups} value={modSel} onChange={setModSel} /></div>}
        <p className="text-xs text-slate-500 md:col-span-2">O valor final, incluindo adicionais, taxas e descontos, é calculado ao criar o pedido.</p>
        <div className="flex items-end"><button className={buttonClass} disabled={busy || !products.length}>{busy ? 'Enviando...' : 'Criar pedido'}</button></div>
      </form>
      </section>
    </div>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Pedidos recentes ({orders.length})</h2><div className="grid gap-3">{orders.map(order => <article key={order.id} className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-brand-50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{order.code} <span className="text-xs font-normal text-slate-400">· {order.channel}</span></h3><p className="mt-1 text-sm text-slate-400">{order.tableLabel ? `Mesa ${order.tableLabel} · ` : ''}{order.customerName || 'Sem cliente informado'} · {new Date(order.createdAt).toLocaleString('pt-BR')}</p><p className="mt-2 text-sm">{order.items.map(line => `${line.quantity}× ${line.product.name}${line.modifiers?.length ? ` (${line.modifiers.map(modifier => `${modifier.quantity}× ${modifier.name}`).join(', ')})` : ''}`).join(', ')}</p></div><div className="text-right"><div className="font-semibold">R$ {Number(order.total).toFixed(2)}</div><div className="mt-1 text-xs text-slate-400">Subtotal {formatMoney(order.subtotal)} · Desconto {formatMoney(order.discount)} · Serviço {formatMoney(order.serviceFee)} · Entrega {formatMoney(order.deliveryFee)}</div><div className="mt-2 flex flex-wrap justify-end gap-2">{order.status !== 'CANCELLED' && <Link href={`/cash?orderId=${encodeURIComponent(order.id)}#pagamento`} className={buttonClass}>Ir para pagamento</Link>}{order.channel === 'DELIVERY' && order.status !== 'CANCELLED' && <Link href={`/delivery?orderId=${encodeURIComponent(order.id)}#nova-entrega`} className={secondaryButtonClass}>Organizar entrega</Link>}<button className={secondaryButtonClass} onClick={() => void reprint(order)}>Reimprimir produção</button></div><select aria-label={`Status do pedido ${order.code}`} className="mt-2 rounded border border-slate-700 bg-slate-950 p-2 text-sm" value={order.status} onChange={e => void updateStatus(order, e.target.value)}><option value="OPEN" disabled={order.status !== 'OPEN'}>Aberto</option><option value="PREPARING" disabled={order.status !== 'PREPARING' && !nextOrderStatuses[order.status]?.includes('PREPARING')}>Em preparo</option><option value="READY" disabled={order.status !== 'READY' && !nextOrderStatuses[order.status]?.includes('READY')}>Pronto</option><option value="COMPLETED" disabled={order.status !== 'COMPLETED' && !nextOrderStatuses[order.status]?.includes('COMPLETED')}>Concluído</option><option value="CANCELLED" disabled={order.status !== 'CANCELLED' && !nextOrderStatuses[order.status]?.includes('CANCELLED')}>Cancelado</option></select></div></div></article>)}{orders.length === 0 && <p className="text-slate-400">Nenhum pedido ainda.</p>}</div></section>
  </AppShell>;
}
