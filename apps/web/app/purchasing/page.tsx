'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney, Ingredient, InventoryAdjustment, ListResponse, PurchaseOrder, Supplier, toIso } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

type Row = { ingredientId: string; quantity: string; unitCost: string };
const emptyRow: Row = { ingredientId: '', quantity: '', unitCost: '' };
const emptySupplier = { name: '', document: '', phone: '', email: '' };
const statusLabel: Record<string, string> = { DRAFT: 'Pendente de recebimento', RECEIVED: 'Recebida', CANCELLED: 'Cancelada' };

export default function PurchasingPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]); const [orders, setOrders] = useState<PurchaseOrder[]>([]); const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [supplierForm, setSupplierForm] = useState(emptySupplier);
  const [orderForm, setOrderForm] = useState({ supplierId: '', dueAt: '', notes: '' }); const [rows, setRows] = useState<Row[]>([{ ...emptyRow }]);
  const [counts, setCounts] = useState<Record<string, string>>({}); const [countNote, setCountNote] = useState(''); const [adjustments, setAdjustments] = useState<InventoryAdjustment[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [s, o, i] = await Promise.all([api<ListResponse<Supplier>>('/purchasing/suppliers'), api<ListResponse<PurchaseOrder>>('/purchasing/orders'), api<ListResponse<Ingredient>>('/inventory/ingredients')]);
      setSuppliers(s.items); setOrders(o.items); setIngredients(i.items);
    } catch (e) { fail(e, 'Erro ao carregar compras'); }
  }
  useAutoLoad(load);

  async function createSupplier(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { await api('/purchasing/suppliers', { method: 'POST', body: JSON.stringify({ name: supplierForm.name, document: supplierForm.document || undefined, phone: supplierForm.phone || undefined, email: supplierForm.email || undefined }) }); ok('Fornecedor cadastrado.'); setSupplierForm(emptySupplier); await load(); } catch (e) { fail(e, 'Erro ao cadastrar fornecedor'); }
  }

  const updateRow = (index: number, patch: Partial<Row>) => setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const orderTotal = rows.reduce((sum, row) => sum + (Number(row.quantity) || 0) * (Number(row.unitCost) || 0), 0);
  async function createOrder(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const body = { supplierId: orderForm.supplierId, dueAt: toIso(orderForm.dueAt), notes: orderForm.notes || undefined, items: rows.map(row => ({ ingredientId: row.ingredientId, quantity: Number(row.quantity), unitCost: Number(row.unitCost) })) };
    try { await api('/purchasing/orders', { method: 'POST', body: JSON.stringify(body) }); ok('Pedido de compra criado.'); setOrderForm({ supplierId: orderForm.supplierId, dueAt: '', notes: '' }); setRows([{ ...emptyRow }]); await load(); } catch (e) { fail(e, 'Erro ao criar pedido de compra'); }
  }
  async function receive(order: PurchaseOrder) {
    if (!window.confirm(`Receber a compra ${order.code}? O estoque, o custo médio e o contas a pagar serão atualizados.`)) return;
    try { await api(`/purchasing/orders/${order.id}/receive`, { method: 'POST' }); ok(`Compra ${order.code} recebida.`); await load(); } catch (e) { fail(e, 'Erro ao receber compra'); }
  }
  async function cancel(order: PurchaseOrder) {
    if (!window.confirm(`Cancelar a compra ${order.code}?`)) return;
    try { await api(`/purchasing/orders/${order.id}/cancel`, { method: 'POST' }); ok(`Compra ${order.code} cancelada.`); await load(); } catch (e) { fail(e, 'Erro ao cancelar compra'); }
  }

  const changedLines = ingredients.filter(item => counts[item.id] !== undefined && counts[item.id] !== '' && Number(counts[item.id]) !== Number(item.currentStock)).map(item => ({ ingredientId: item.id, countedQuantity: Number(counts[item.id]) }));
  async function submitCount() {
    setNotice(null);
    try {
      const result = await api<{ adjustments: InventoryAdjustment[]; adjusted: number }>('/inventory/counts', { method: 'POST', body: JSON.stringify({ note: countNote || undefined, lines: changedLines }) });
      setAdjustments(result.adjustments); setCounts({}); setCountNote(''); ok(`Inventário registrado: ${result.adjusted} ajuste(s).`); await load();
    } catch (e) { fail(e, 'Erro ao registrar inventário'); }
  }

  return <AppShell title="Compras e fornecedores">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Fornecedores ({suppliers.length})</h2>
      <form onSubmit={createSupplier} className="grid gap-4 md:grid-cols-5"><Field label="Nome" required minLength={2} maxLength={160} value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} /><Field label="CNPJ/CPF" maxLength={20} value={supplierForm.document} onChange={e => setSupplierForm({ ...supplierForm, document: e.target.value })} /><Field label="Telefone" maxLength={30} value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} /><Field label="E-mail" type="email" value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} /><div className="flex items-end"><button className={buttonClass}>Adicionar</button></div></form>
      <div className="mt-4 grid gap-2 md:grid-cols-3">{suppliers.map(item => <div key={item.id} className="rounded-lg border border-slate-800 p-3 text-sm"><div className="font-semibold">{item.name}</div><div className="text-slate-400">{[item.document, item.phone, item.email].filter(Boolean).join(' · ') || 'Sem contato'}</div></div>)}</div>{suppliers.length === 0 && <p className="mt-4 text-slate-400">Nenhum fornecedor cadastrado.</p>}</section>

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Novo pedido de compra</h2>
      <form onSubmit={createOrder} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3"><Select label="Fornecedor" required value={orderForm.supplierId} onChange={e => setOrderForm({ ...orderForm, supplierId: e.target.value })}><option value="">Selecione</option>{suppliers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Field label="Vencimento (opcional)" type="datetime-local" value={orderForm.dueAt} onChange={e => setOrderForm({ ...orderForm, dueAt: e.target.value })} /><Field label="Observações" maxLength={500} value={orderForm.notes} onChange={e => setOrderForm({ ...orderForm, notes: e.target.value })} /></div>
        {rows.map((row, index) => <div key={index} className="grid items-end gap-3 md:grid-cols-[2fr_1fr_1fr_auto]"><Select label={index === 0 ? 'Ingrediente' : ''} aria-label="Ingrediente" required value={row.ingredientId} onChange={e => updateRow(index, { ingredientId: e.target.value })}><option value="">Selecione</option>{ingredients.map(item => <option key={item.id} value={item.id}>{item.name} ({item.unitOfMeasure})</option>)}</Select><Field label={index === 0 ? 'Quantidade' : ''} aria-label="Quantidade" type="number" required min="0.001" step="0.001" value={row.quantity} onChange={e => updateRow(index, { quantity: e.target.value })} /><Field label={index === 0 ? 'Custo unitário (R$)' : ''} aria-label="Custo unitário" type="number" required min="0" step="0.01" value={row.unitCost} onChange={e => updateRow(index, { unitCost: e.target.value })} /><button type="button" className={secondaryButtonClass} disabled={rows.length === 1} onClick={() => setRows(current => current.filter((_, i) => i !== index))}>Remover</button></div>)}
        <div className="flex flex-wrap items-center gap-3"><button type="button" className={secondaryButtonClass} disabled={rows.length >= 200} onClick={() => setRows(current => [...current, { ...emptyRow }])}>+ Adicionar item</button><span className="text-sm text-slate-300">Total: <strong>{formatMoney(orderTotal)}</strong></span><button className={buttonClass}>Criar pedido de compra</button></div>
      </form></section>

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Pedidos de compra ({orders.length})</h2><div className="grid gap-3">{orders.map(order => <article key={order.id} className="rounded-lg border border-slate-800 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{order.code} · {order.supplier.name} <span className="text-xs font-normal text-blue-300">{statusLabel[order.status] ?? order.status}</span></h3><p className="mt-1 text-sm text-slate-400">Criada em {formatDateTime(order.createdAt)}{order.dueAt ? ` · vence em ${formatDateTime(order.dueAt)}` : ''} · {formatMoney(order.total)}</p><ul className="mt-2 text-sm text-slate-300">{order.items.map(line => <li key={line.id}>{Number(line.quantity)} {line.ingredient.unitOfMeasure} de {line.ingredient.name} × {formatMoney(line.unitCost)}</li>)}</ul></div>{order.status === 'DRAFT' && <div className="flex gap-2"><button className={buttonClass} onClick={() => void receive(order)}>Receber</button><button className={secondaryButtonClass} onClick={() => void cancel(order)}>Cancelar</button></div>}</div></article>)}</div>{orders.length === 0 && <p className="text-slate-400">Nenhum pedido de compra.</p>}</section>

    <section className={panelClass}><h2 className="mb-1 text-lg font-semibold">Inventário guiado</h2><p className="mb-4 text-sm text-slate-400">Informe a quantidade contada. Somente as linhas alteradas serão enviadas e ajustadas no estoque.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="py-2">Ingrediente</th><th>Estoque atual</th><th>Quantidade contada</th><th>Diferença</th></tr></thead><tbody>{ingredients.map(item => { const counted = counts[item.id]; const diff = counted ? Number(counted) - Number(item.currentStock) : 0; return <tr key={item.id} className="border-t border-slate-800"><td className="py-2">{item.name}</td><td>{Number(item.currentStock)} {item.unitOfMeasure}</td><td><input aria-label={`Quantidade contada de ${item.name}`} type="number" min="0" step="0.001" className="w-32 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-white" value={counted ?? ''} onChange={e => setCounts({ ...counts, [item.id]: e.target.value })} /></td><td className={diff < 0 ? 'text-red-300' : diff > 0 ? 'text-emerald-300' : 'text-slate-500'}>{counted ? (diff > 0 ? '+' : '') + Number(diff.toFixed(3)) : '—'}</td></tr>; })}</tbody></table></div>
      {ingredients.length === 0 && <p className="text-slate-400">Nenhum ingrediente cadastrado.</p>}
      <div className="mt-4 flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label="Observação do inventário" maxLength={300} value={countNote} onChange={e => setCountNote(e.target.value)} /></div><button className={buttonClass} disabled={changedLines.length === 0} onClick={() => void submitCount()}>Registrar inventário ({changedLines.length})</button></div>
      {adjustments && <div className="mt-5"><h3 className="mb-2 font-semibold">Ajustes aplicados</h3>{adjustments.length === 0 ? <p className="text-sm text-slate-400">Nenhuma diferença encontrada.</p> : <ul className="grid gap-1 text-sm">{adjustments.map(item => <li key={item.ingredientId} className="rounded-lg border border-slate-800 px-3 py-2">{item.name}: {Number(item.previous)} → {Number(item.counted)} ({Number(item.difference) > 0 ? '+' : ''}{Number(item.difference)})</li>)}</ul>}</div>}
    </section>
  </AppShell>;
}
