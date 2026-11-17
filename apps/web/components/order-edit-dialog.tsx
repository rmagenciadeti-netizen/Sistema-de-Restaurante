'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, formatMoney, ListResponse } from '../lib/api';
import { methodLabels, opsError, orderTitle, type OpsOrder, type OpsProduct, type OpsZone } from '../lib/types-ops';
import { buttonClass, inputClass, secondaryButtonClass } from './app-shell';
import { parseQuantity } from '../lib/quantity';

type Line = { key: number; productId: string; quantity: number | string; weightKg: string; unitPrice: string; withPackaging: boolean; notes: string; modifiers: { optionId: string; quantity: number }[] };

const money = (value: string | number | null | undefined) => String(Number(value ?? 0));
const lineKey = (line: Line) => ({ productId: line.productId, quantity: line.quantity, weightKg: line.weightKg, unitPrice: line.unitPrice, withPackaging: line.withPackaging, notes: line.notes, modifiers: line.modifiers });

// Full manual control of an order in progress; only the fields that changed are sent, and the API recomputes totals, stock and kitchen tickets.
export function OrderEditDialog({ order, onClose, onSaved }: { order: OpsOrder; onClose: () => void; onSaved: (message: string) => void }) {
  const isDelivery = order.channel === 'DELIVERY';
  const initial = useMemo(() => ({
    customerName: order.customerName ?? order.customer?.name ?? '', customerPhone: order.customer?.phone ?? '', tableLabel: order.tableLabel ?? '',
    address: order.deliveryJob?.address ?? '', zoneId: order.deliveryZone?.id ?? '', deliveryFee: money(order.deliveryFee), discount: money(order.discount), serviceFee: money(order.serviceFee),
    lines: order.items.filter(item => !item.parentItemId).map((item, index): Line => ({ key: index, productId: item.product.id ?? '', quantity: Number(item.quantity), weightKg: item.weightKg ? String(Number(item.weightKg)) : '', unitPrice: money(item.unitPrice), withPackaging: Boolean(item.withPackaging), notes: item.notes ?? '', modifiers: (item.modifiers ?? []).filter(modifier => modifier.optionId).map(modifier => ({ optionId: modifier.optionId!, quantity: modifier.quantity })) })),
    payments: (order.payments ?? []).map(payment => ({ id: payment.id, amount: payment.amount, method: payment.method })),
  }), [order]);
  const [form, setForm] = useState({ customerName: initial.customerName, customerPhone: initial.customerPhone, tableLabel: initial.tableLabel, address: initial.address, zoneId: initial.zoneId, deliveryFee: initial.deliveryFee, discount: initial.discount, serviceFee: initial.serviceFee });
  const [lines, setLines] = useState<Line[]>(initial.lines);
  const [methods, setMethods] = useState<Record<string, string>>(() => Object.fromEntries(initial.payments.map(payment => [payment.id, payment.method])));
  const [products, setProducts] = useState<OpsProduct[]>([]);
  const [zones, setZones] = useState<OpsZone[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nextKey, setNextKey] = useState(initial.lines.length);

  useEffect(() => {
    let alive = true;
    void Promise.all([api<ListResponse<OpsProduct>>('/products'), isDelivery ? api<ListResponse<OpsZone>>('/delivery/zones').catch(() => ({ items: [] as OpsZone[] })) : Promise.resolve({ items: [] as OpsZone[] })])
      .then(([catalog, zoneList]) => { if (alive) { setProducts(catalog.items.filter(product => product.active)); setZones(zoneList.items); } })
      .catch(e => { if (alive) setError(opsError(e, 'Erro ao carregar produtos')); });
    return () => { alive = false; };
  }, [isDelivery]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const productOf = (id: string) => products.find(product => product.id === id);
  const nameOf = (line: Line) => productOf(line.productId)?.name ?? order.items.find(item => item.product.id === line.productId)?.product.name ?? 'Produto';
  const set = (change: Partial<typeof form>) => setForm(current => ({ ...current, ...change }));
  const patchLine = (key: number, change: Partial<Line>) => setLines(current => current.map(line => line.key === key ? { ...line, ...change } : line));
  const changeZone = (zoneId: string) => { const zone = zones.find(item => item.id === zoneId); set({ zoneId, deliveryFee: zone ? money(zone.fee) : '0' }); };
  const addLine = () => { const first = products[0]; if (!first) return; setLines(current => [...current, { key: nextKey, productId: first.id, quantity: 1, weightKg: '', unitPrice: '', withPackaging: false, notes: '', modifiers: [] }]); setNextKey(nextKey + 1); };

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (lines.length === 0) { setError('O pedido precisa ter ao menos um item.'); return; }
    if (lines.some(line => { const product = productOf(line.productId); return parseQuantity(line.quantity, Boolean(product?.allowFractionalQuantity && !product.soldByWeight), 999) === null; })) { setError('Informe quantidades válidas; produtos fracionados aceitam até três casas decimais.'); return; }
    if (lines.some(line => productOf(line.productId)?.soldByWeight && !(Number(line.weightKg) > 0))) { setError('Informe o peso (kg) dos produtos vendidos por peso.'); return; }
    if (lines.some(line => line.unitPrice.trim() && (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(line.unitPrice.trim()) || Number(line.unitPrice.replace(',', '.')) > 9_999_999_999.99))) { setError('Informe preços livres válidos, com até duas casas decimais.'); return; }
    const body: Record<string, unknown> = {};
    if (form.customerName.trim() !== initial.customerName) body.customerName = form.customerName.trim() || null;
    if (form.customerPhone.trim() !== initial.customerPhone) body.customerPhone = form.customerPhone.trim() || null;
    if (form.tableLabel.trim() !== initial.tableLabel) body.tableLabel = form.tableLabel.trim() || null;
    if (isDelivery) {
      if (form.address.trim() !== initial.address) body.address = form.address.trim() || null;
      if (form.zoneId !== initial.zoneId) body.deliveryZoneId = form.zoneId || null;
      if (Number(form.deliveryFee) !== Number(initial.deliveryFee)) body.deliveryFee = Number(form.deliveryFee);
    }
    if (Number(form.discount) !== Number(initial.discount)) body.discount = Number(form.discount);
    if (Number(form.serviceFee) !== Number(initial.serviceFee)) body.serviceFee = Number(form.serviceFee);
    if (JSON.stringify(lines.map(lineKey)) !== JSON.stringify(initial.lines.map(lineKey))) {
      body.items = lines.map(line => ({ productId: line.productId, quantity: parseQuantity(line.quantity, Boolean(productOf(line.productId)?.allowFractionalQuantity && !productOf(line.productId)?.soldByWeight), 999), weightKg: productOf(line.productId)?.soldByWeight && line.weightKg ? Number(line.weightKg) : undefined, unitPrice: order.channel === 'POS' && productOf(line.productId)?.allowFreePrice && line.unitPrice.trim() ? Number(line.unitPrice.replace(',', '.')) : undefined, withPackaging: line.withPackaging || undefined, notes: line.notes.trim() || undefined, modifiers: line.modifiers.length ? line.modifiers : undefined }));
    }
    const payments = initial.payments.filter(payment => methods[payment.id] !== payment.method).map(payment => ({ id: payment.id, method: methods[payment.id] }));
    if (payments.length) body.payments = payments;
    if (Object.keys(body).length === 0) { onClose(); return; }
    setBusy(true);
    try { await api(`/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify(body) }); onSaved(`Pedido ${orderTitle(order)} atualizado.`); }
    catch (e) { setError(opsError(e, 'Erro ao salvar o pedido')); setBusy(false); }
  }

  const label = 'block text-sm font-medium text-slate-700';
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:p-6 print:hidden" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-label={`Editar pedido ${orderTitle(order)}`} onSubmit={save} className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Editar pedido</p><h2 className="text-xl font-bold text-slate-900">{orderTitle(order)} <span className="text-sm font-normal text-slate-500">· {order.code}</span></h2></div>
        <button type="button" aria-label="Fechar" className={secondaryButtonClass} onClick={onClose}>✕</button>
      </div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Cliente</legend>
        <label className={label}>Nome<input className={inputClass} maxLength={160} value={form.customerName} onChange={e => set({ customerName: e.target.value })} /></label>
        <label className={label}>Telefone<input className={inputClass} maxLength={30} value={form.customerPhone} onChange={e => set({ customerPhone: e.target.value })} /></label>
        {(order.channel === 'TABLE' || order.tableLabel) && <label className={label}>Mesa / comanda<input className={inputClass} maxLength={30} value={form.tableLabel} onChange={e => set({ tableLabel: e.target.value })} /></label>}
      </fieldset>

      {isDelivery && <fieldset className="mt-5 grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Entrega</legend>
        <label className={`${label} sm:col-span-2`}>Endereço de entrega<input className={inputClass} maxLength={500} value={form.address} onChange={e => set({ address: e.target.value })} /></label>
        <label className={label}>Zona de entrega<select className={inputClass} value={form.zoneId} onChange={e => changeZone(e.target.value)}><option value="">Sem zona</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name} — {formatMoney(zone.fee)}</option>)}</select></label>
        <label className={label}>Taxa de entrega (R$)<input className={inputClass} type="number" min="0" step="0.01" value={form.deliveryFee} onChange={e => set({ deliveryFee: e.target.value })} /></label>
      </fieldset>}

      <fieldset className="mt-5"><legend className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Itens</legend>
        <div className="grid gap-2">{lines.map(line => {
          const product = productOf(line.productId);
          return <div key={line.key} className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 sm:grid-cols-[minmax(0,1fr)_5rem_6rem_auto]">
            <select aria-label="Produto" className={inputClass} value={line.productId} onChange={e => patchLine(line.key, { productId: e.target.value, modifiers: [], weightKg: '', unitPrice: '', withPackaging: false })}>
              {!product && <option value={line.productId}>{nameOf(line)}</option>}
              {products.map(item => <option key={item.id} value={item.id}>{item.name} — {formatMoney(item.price)}</option>)}
            </select>
            <input aria-label="Quantidade" className={inputClass} type="text" inputMode={product?.allowFractionalQuantity && !product.soldByWeight ? 'decimal' : 'numeric'} value={line.quantity} onChange={e => patchLine(line.key, { quantity: e.target.value })} />
            {product?.soldByWeight ? <input aria-label="Peso (kg)" placeholder="kg" className={inputClass} type="number" min="0" step="0.001" value={line.weightKg} onChange={e => patchLine(line.key, { weightKg: e.target.value })} /> : <span />}
            <button type="button" className={secondaryButtonClass} onClick={() => setLines(current => current.filter(item => item.key !== line.key))} aria-label={`Remover ${nameOf(line)}`}>Remover</button>
            <input aria-label="Observação" placeholder="Observação do item" maxLength={500} className={`${inputClass} sm:col-span-4`} value={line.notes} onChange={e => patchLine(line.key, { notes: e.target.value })} />
            {product?.packagingEnabled && <label className={`${label} flex items-center gap-2 sm:col-span-4`}><input type="checkbox" checked={line.withPackaging} onChange={e => patchLine(line.key, { withPackaging: e.target.checked })} className="h-4 w-4 accent-brand-600" />Adicionar embalagem {Number(product.packagingPrice) > 0 && `(+${formatMoney(product.packagingPrice)})`}</label>}
            {order.channel === 'POS' && product?.allowFreePrice && !product.soldByWeight && <label className={`${label} sm:col-span-4`}>Preço livre deste item (R$)<input aria-label="Preço livre (R$)" className={inputClass} type="number" min="0" max="9999999999.99" step="0.01" value={line.unitPrice} onChange={e => patchLine(line.key, { unitPrice: e.target.value })} /></label>}
            {line.modifiers.length > 0 && <p className="text-xs text-slate-500 sm:col-span-4">Os adicionais deste item são mantidos. Trocar o produto remove os adicionais.</p>}
          </div>;
        })}</div>
        <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={products.length === 0} onClick={addLine}>+ Adicionar item</button>
      </fieldset>

      <fieldset className="mt-5 grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Valores</legend>
        <label className={label}>Desconto (R$)<input className={inputClass} type="number" min="0" step="0.01" value={form.discount} onChange={e => set({ discount: e.target.value })} /></label>
        <label className={label}>Taxa de serviço (R$)<input className={inputClass} type="number" min="0" step="0.01" value={form.serviceFee} onChange={e => set({ serviceFee: e.target.value })} /></label>
        <p className="text-xs text-slate-500 sm:col-span-2">Subtotal, taxas e total são recalculados ao salvar. Hoje: {formatMoney(order.total)}. Alterar o desconto exige perfil de gerência.</p>
      </fieldset>

      <fieldset className="mt-5"><legend className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Pagamento</legend>
        {initial.payments.length === 0 ? <p className="text-sm text-slate-500">Nenhum pagamento registrado.</p>
          : <div className="grid gap-2">{initial.payments.map(payment => <label key={payment.id} className={`${label} flex flex-wrap items-center gap-3`}><span className="min-w-24">{formatMoney(payment.amount)}</span>
            <select className={`${inputClass} !mt-0 w-auto`} value={methods[payment.id]} onChange={e => setMethods(current => ({ ...current, [payment.id]: e.target.value }))}>{Object.entries(methodLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}</div>}
        <Link href={`/cash?orderId=${encodeURIComponent(order.id)}#pagamento`} className="mt-2 inline-block text-sm font-semibold text-brand-700 hover:text-brand-600">Registrar novo pagamento no caixa ›</Link>
      </fieldset>

      <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={onClose}>Cancelar</button><button className={buttonClass} disabled={busy}>{busy ? 'Salvando…' : 'Salvar alterações'}</button></div>
    </form>
  </div>;
}
