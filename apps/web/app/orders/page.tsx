'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, ApiError, DeliveryZone, errorMessage, formatMoney, ListResponse, ModifierGroup, Order, Product, ProductComposition, RestaurantTable, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { parseQuantity } from '../../lib/quantity';
import { ModifierPicker, ModifierSelection, modifiersPayload, selectionError } from '../../components/modifier-picker';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const nextOrderStatuses: Record<string, string[]> = {
  OPEN: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
type OrderWithPromissory = Order & { financialEntry?: { id: string; debtorName: string | null; amount: string | number; paidAmount: string | number; dueAt: string | null; status: string } | null };
type PromissoryDocument = { debtorName: string; amount: string | number; dueAt: string; orderCode: string; orderNumber: number | null; paper: 'A4' | '80mm'; autoPrint: boolean };
const localDateAfterDays = (days: number) => { const date = new Date(Date.now() + days * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderWithPromissory[]>([]); const [products, setProducts] = useState<Product[]>([]); const [message, setMessage] = useState(''); const [productId, setProductId] = useState(''); const [quantity, setQuantity] = useState('1'); const [withPackaging, setWithPackaging] = useState(false); const [channel, setChannel] = useState('POS'); const [tableLabel, setTableLabel] = useState(''); const [customerName, setCustomerName] = useState(''); const [busy, setBusy] = useState(false); const [tables, setTables] = useState<RestaurantTable[]>([]); const [zones, setZones] = useState<DeliveryZone[]>([]); const [tableId, setTableId] = useState(''); const [zoneId, setZoneId] = useState(''); const [customerPhone, setCustomerPhone] = useState(''); const [marketingConsent, setMarketingConsent] = useState(false); const [couponCode, setCouponCode] = useState(''); const [applyServiceFee, setApplyServiceFee] = useState(true); const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]); const [compositions, setCompositions] = useState<Record<string, ProductComposition>>({}); const [modSel, setModSel] = useState<ModifierSelection>({});
  const [promissoryTarget, setPromissoryTarget] = useState<OrderWithPromissory | null>(null); const [promissoryDebtor, setPromissoryDebtor] = useState(''); const [promissoryDueAt, setPromissoryDueAt] = useState(localDateAfterDays(7)); const [promissoryDocument, setPromissoryDocument] = useState<PromissoryDocument | null>(null);
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
    setProductId(id); setModSel({}); setWithPackaging(false);
    if (!id || compositions[id]) return;
    try { const data = await api<ProductComposition>(`/catalog/products/${id}/composition`); setCompositions(current => ({ ...current, [id]: data })); } catch (error) { if (!(error instanceof ApiError && error.status === 403)) setMessage(errorMessage(error, 'Erro ao carregar composição do produto')); }
  }
  const composition = compositions[productId];
  const selectedProduct = products.find(product => product.id === productId);
  const productGroups = modifierGroups.filter(group => group.active && composition?.modifierGroups.some(link => link.groupId === group.id)).map(group => ({ ...group, options: group.options.filter(option => option.active !== false) }));
  const unitTables = tables.filter(table => table.unitId === unitId);
  const search = productSearch.trim().toLocaleLowerCase('pt-BR');
  const filteredProducts = products.filter(product => `${product.name} ${product.code ?? ''}`.toLocaleLowerCase('pt-BR').includes(search));
  async function createOrder(event: React.FormEvent) { event.preventDefault(); if (!productId) { setMessage('Cadastre ou selecione um produto antes de abrir o pedido.'); return; } const parsedQuantity = parseQuantity(quantity, Boolean(selectedProduct?.allowFractionalQuantity), 999); if (parsedQuantity === null) { setMessage('Informe uma quantidade válida; produtos fracionados aceitam até três casas decimais.'); return; } if (channel === 'TABLE' && !unitId) { setMessage('Selecione a unidade do pedido de mesa.'); return; } const modifierError = selectionError(productGroups, modSel); if (modifierError) { setMessage(modifierError); return; } setBusy(true); setMessage(''); try { await api('/orders', { method: 'POST', body: JSON.stringify({ channel, unitId: channel === 'TABLE' ? unitId : undefined, customerName: customerName || undefined, customerPhone: customerName && customerPhone ? customerPhone : undefined, marketingConsent: customerName ? marketingConsent : undefined, tableId: channel === 'TABLE' && tableId ? tableId : undefined, tableLabel: channel === 'TABLE' && !tableId ? tableLabel || undefined : undefined, deliveryZoneId: channel === 'DELIVERY' && zoneId ? zoneId : undefined, couponCode: couponCode.trim() || undefined, applyServiceFee: channel === 'TABLE' ? applyServiceFee : undefined, items: [{ productId, quantity: parsedQuantity, withPackaging: withPackaging || undefined, modifiers: modifiersPayload(modSel) }] }) }); setMessage('Pedido criado e encaminhado ao fluxo de produção.'); setCustomerName(''); setCustomerPhone(''); setMarketingConsent(false); setCouponCode(''); setApplyServiceFee(true); setTableLabel(''); setTableId(''); setZoneId(''); setQuantity('1'); setModSel({}); setWithPackaging(false); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao criar pedido'); } finally { setBusy(false); } }
  async function updateStatus(order: Order, status: string) { try { await api(`/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao atualizar pedido'); } }
  async function reprint(order: Order) { try { await api(`/printing/orders/${order.id}/print`, { method: 'POST' }); setMessage(`Produção do pedido ${order.code} reenviada para impressão.`); } catch (e) { setMessage(errorMessage(e, 'Erro ao reimprimir produção')); } }
  async function createPromissory(event: React.FormEvent) {
    event.preventDefault();
    if (!promissoryTarget || !promissoryDebtor.trim() || !promissoryDueAt) return;
    setBusy(true); setMessage('');
    try {
      const result = await api<{ debtorName: string; amount: string | number; dueAt: string; autoPrintPromissory: boolean; promissoryPaper: 'A4' | '80mm'; order: { code: string; number: number | null } }>(`/orders/${promissoryTarget.id}/promissory`, {
        method: 'POST', body: JSON.stringify({ debtorName: promissoryDebtor.trim(), dueAt: new Date(`${promissoryDueAt}T12:00:00`).toISOString() }),
      });
      setPromissoryDocument({ debtorName: result.debtorName, amount: result.amount, dueAt: result.dueAt, orderCode: result.order.code, orderNumber: result.order.number, paper: result.promissoryPaper, autoPrint: result.autoPrintPromissory });
      setPromissoryTarget(null); setMessage('Promissória registrada em Contas a receber.');
      if (result.autoPrintPromissory) window.setTimeout(() => printPromissory(), 250);
      await load();
    } catch (e) { setMessage(errorMessage(e, 'Erro ao gerar promissória')); }
    finally { setBusy(false); }
  }
  function printPromissory() {
    document.body.classList.add('rm-promissory-print');
    const cleanup = () => document.body.classList.remove('rm-promissory-print');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  }
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
        <label className="text-sm text-slate-700">Canal
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900" value={channel} onChange={e => setChannel(e.target.value)}>
            <option value="POS">PDV</option><option value="TABLE">Mesa / comanda</option><option value="DELIVERY">Delivery</option><option value="TAKEAWAY">Retirada</option><option value="WHATSAPP">WhatsApp</option>
          </select>
        </label>
        <label className="text-sm text-slate-700">Produto
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900" value={productId} onChange={e => void chooseProduct(e.target.value)}>
            <option value="">Selecione</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} — R$ {Number(product.price).toFixed(2)}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-700">Quantidade<input type="text" inputMode={selectedProduct?.allowFractionalQuantity ? 'decimal' : 'numeric'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        {channel === 'TABLE' && <Select label="Unidade" required value={unitId} onChange={e => { setUnitId(e.target.value); setTableId(''); setTableLabel(''); }}>
          <option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
        </Select>}
        {channel === 'TABLE' && unitId && (unitTables.length > 0
          ? <Select label="Mesa" value={tableId} onChange={e => setTableId(e.target.value)}><option value="">Selecione</option>{unitTables.map(table => <option key={table.id} value={table.id}>Mesa {table.label} ({table.seats} lugares)</option>)}</Select>
          : <Field label="Mesa / comanda" value={tableLabel} onChange={e => setTableLabel(e.target.value)} />)}
        {channel === 'DELIVERY' && <Select label="Zona de entrega" value={zoneId} onChange={e => setZoneId(e.target.value)}><option value="">Selecione</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name} — {formatMoney(zone.fee)}</option>)}</Select>}
        {selectedProduct?.packagingEnabled && <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={withPackaging} onChange={e => setWithPackaging(e.target.checked)} className="h-4 w-4 accent-brand-600" />Adicionar embalagem {Number(selectedProduct.packagingPrice) > 0 && `(+${formatMoney(selectedProduct.packagingPrice)})`}</label>}
        <Field label="Cliente" maxLength={160} value={customerName} onChange={e => setCustomerName(e.target.value)} />
        <Field label="Telefone do cliente" maxLength={30} value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
        <Field label="Cupom" maxLength={40} value={couponCode} onChange={e => setCouponCode(e.target.value)} />
        <div className="flex flex-col justify-end gap-2">
          {channel === 'TABLE' && <Check label="Cobrar taxa de serviço" checked={applyServiceFee} onChange={e => setApplyServiceFee(e.target.checked)} />}
          <Check label="Cliente consentiu marketing (LGPD)" checked={marketingConsent} disabled={!customerName} onChange={e => setMarketingConsent(e.target.checked)} />
        </div>
        {composition?.isCombo && <p className="text-sm text-blue-700 md:col-span-2">Combo: {composition.comboComponents.map(component => `${component.quantity}× ${component.product.name}`).join(', ')}</p>}
        {productGroups.length > 0 && <div className="md:col-span-2"><ModifierPicker groups={productGroups} value={modSel} onChange={setModSel} /></div>}
        <p className="text-xs text-slate-500 md:col-span-2">O valor final, incluindo adicionais, taxas e descontos, é calculado ao criar o pedido.</p>
        <div className="flex items-end"><button className={buttonClass} disabled={busy || !products.length}>{busy ? 'Enviando...' : 'Criar pedido'}</button></div>
      </form>
      </section>
    </div>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Pedidos recentes ({orders.length})</h2><div className="grid gap-3">{orders.map(order => <article key={order.id} className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-brand-50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{order.code} <span className="text-xs font-normal text-slate-500">· {order.channel}</span></h3><p className="mt-1 text-sm text-slate-600">{order.tableLabel ? `Mesa ${order.tableLabel} · ` : ''}{order.customerName || 'Sem cliente informado'} · {new Date(order.createdAt).toLocaleString('pt-BR')}</p><p className="mt-2 text-sm">{order.items.map(line => `${line.quantity}× ${line.product.name}${line.modifiers?.length ? ` (${line.modifiers.map(modifier => `${modifier.quantity}× ${modifier.name}`).join(', ')})` : ''}`).join(', ')}</p>{order.financialEntry && <p className="mt-2 text-xs font-medium text-amber-800">Promissória {order.financialEntry.status === 'PAID' ? 'baixada' : order.financialEntry.status === 'CANCELLED' ? 'cancelada' : `em aberto · ${formatMoney(Number(order.financialEntry.amount) - Number(order.financialEntry.paidAmount))}`}</p>}</div><div className="text-right"><div className="font-semibold">R$ {Number(order.total).toFixed(2)}</div><div className="mt-1 text-xs text-slate-500">Subtotal {formatMoney(order.subtotal)} · Desconto {formatMoney(order.discount)} · Serviço {formatMoney(order.serviceFee)} · Entrega {formatMoney(order.deliveryFee)}</div><div className="mt-2 flex flex-wrap justify-end gap-2">{order.status !== 'CANCELLED' && <Link href={`/cash?orderId=${encodeURIComponent(order.id)}#pagamento`} className={buttonClass}>Ir para pagamento</Link>}{order.status !== 'CANCELLED' && !order.financialEntry && (order.payments ?? []).reduce((sum, payment) => sum + Number(payment.amount), 0) < Number(order.total) && <button className={secondaryButtonClass} onClick={() => { setPromissoryTarget(order); setPromissoryDebtor(order.customerName ?? ''); setPromissoryDueAt(localDateAfterDays(7)); }}>Gerar promissória</button>}{order.channel === 'DELIVERY' && order.status !== 'CANCELLED' && <Link href="/monitor" className={secondaryButtonClass}>Despachar no quadro</Link>}<button className={secondaryButtonClass} onClick={() => void reprint(order)}>Reimprimir produção</button></div><select aria-label={`Status do pedido ${order.code}`} className="mt-2 rounded border border-slate-300 bg-white p-2 text-sm text-slate-900" value={order.status} onChange={e => void updateStatus(order, e.target.value)}><option value="OPEN" disabled={order.status !== 'OPEN'}>Aberto</option><option value="PREPARING" disabled={order.status !== 'PREPARING' && !nextOrderStatuses[order.status]?.includes('PREPARING')}>Em preparo</option><option value="READY" disabled={order.status !== 'READY' && !nextOrderStatuses[order.status]?.includes('READY')}>Pronto</option><option value="COMPLETED" disabled={order.status !== 'COMPLETED' && !nextOrderStatuses[order.status]?.includes('COMPLETED')}>Concluído</option><option value="CANCELLED" disabled={order.status !== 'CANCELLED' && !nextOrderStatuses[order.status]?.includes('CANCELLED')}>Cancelado</option></select></div></div></article>)}{orders.length === 0 && <p className="text-slate-500">Nenhum pedido ainda.</p>}</div></section>
    {promissoryTarget && <div role="dialog" aria-modal="true" aria-label="Gerar promissória" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><form onSubmit={createPromissory} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><h2 className="text-lg font-bold text-slate-900">Venda a prazo · {promissoryTarget.code}</h2><p className="mt-1 text-sm text-slate-500">Saldo do pedido: {formatMoney(promissoryTarget.total)}</p><Field label="Responsável pela dívida" required minLength={2} maxLength={160} value={promissoryDebtor} onChange={e => setPromissoryDebtor(e.target.value)} /><Field label="Vencimento" type="date" required value={promissoryDueAt} onChange={e => setPromissoryDueAt(e.target.value)} /><div className="mt-4 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setPromissoryTarget(null)}>Cancelar</button><button className={buttonClass} disabled={busy}>{busy ? 'Registrando…' : 'Gerar promissória'}</button></div></form></div>}
    {promissoryDocument && <><style>{`@media print{body.rm-promissory-print *{visibility:hidden!important}body.rm-promissory-print .rm-promissory-document,body.rm-promissory-print .rm-promissory-document *{visibility:visible!important}body.rm-promissory-print .rm-promissory-document{display:block!important;position:absolute;inset:0;margin:auto;background:white;color:black}}`}</style><section className="rm-promissory-document hidden bg-white p-8 font-mono text-black print:block" style={{ width: promissoryDocument.paper === 'A4' ? '210mm' : '80mm', minHeight: promissoryDocument.paper === 'A4' ? '297mm' : undefined }}><h1 className="text-center text-xl font-bold">Promissória de venda</h1><p className="mt-8">Pedido: {promissoryDocument.orderNumber ? `#${promissoryDocument.orderNumber}` : promissoryDocument.orderCode}</p><p className="mt-4">Responsável: {promissoryDocument.debtorName}</p><p className="mt-4">Valor: {formatMoney(promissoryDocument.amount)}</p><p className="mt-4">Vencimento: {new Date(promissoryDocument.dueAt).toLocaleDateString('pt-BR')}</p><p className="mt-8 text-sm">Referente à venda identificada pelo pedido acima.</p><div className="mt-20 border-t border-black pt-2 text-center">Assinatura do responsável</div></section><div role="dialog" aria-modal="true" aria-label="Promissória gerada" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 print:hidden"><div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center shadow-2xl"><h2 className="text-lg font-bold">Promissória registrada</h2><p className="mt-2 text-sm text-slate-600">{promissoryDocument.debtorName} · {formatMoney(promissoryDocument.amount)} · vence em {new Date(promissoryDocument.dueAt).toLocaleDateString('pt-BR')}</p><div className="mt-4 flex justify-center gap-2"><button className={secondaryButtonClass} onClick={() => setPromissoryDocument(null)}>Fechar</button><button className={buttonClass} onClick={printPromissory}>Imprimir</button></div></div></div></>}
  </AppShell>;
}
