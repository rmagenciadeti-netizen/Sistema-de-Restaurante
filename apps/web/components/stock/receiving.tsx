'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage, formatMoney, type Ingredient, type ListResponse, type PurchaseOrder } from '../../lib/api';
import type { ReceivedInvoice } from '../../lib/types-fiscal';
import { buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable } from '../ui';

type Conference = { lines: { itemId: string; invoiceMatch: { description: string; quantity: number | null; unitValue: number | null; score: number } | null }[] };
type Result = { conference: { divergences: { itemId: string; name: string; kind: string; detail: string }[]; orderedTotal: number; receivedTotal: number } };
type Line = { quantity: string; cost: string; expiresAt: string };
const kindLabel: Record<string, string> = { SHORT: 'Faltou', OVER: 'Veio a mais', PRICE_UP: 'Preço maior', PRICE_DOWN: 'Preço menor', NOT_RECEIVED: 'Não recebido' };

// Receiving with conference: what actually arrived (quantity, price, expiry), optionally checked against an imported supplier XML.
export function ReceivingConference({ order, onDone, onCancel }: { order: PurchaseOrder; onDone: (message: string) => void; onCancel: () => void }) {
  const [lines, setLines] = useState<Record<string, Line>>(() => Object.fromEntries(order.items.map(item => [item.id, { quantity: String(Number(item.quantity)), cost: String(Number(item.unitCost)), expiresAt: '' }])));
  const [invoices, setInvoices] = useState<ReceivedInvoice[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [conference, setConference] = useState<Conference | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<ListResponse<ReceivedInvoice>>('/fiscal-registry/invoices').then(data => setInvoices(data.items)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!invoiceId) return;
    let active = true;
    api<Conference>(`/purchasing/orders/${order.id}/conference?invoiceId=${invoiceId}`).then(data => { if (active) setConference(data); }).catch(cause => { if (active) setError(errorMessage(cause, 'Falha ao comparar com a nota')); });
    return () => { active = false; };
  }, [invoiceId, order.id]);

  const set = (id: string, patch: Partial<Line>) => setLines(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  const applyInvoice = () => {
    if (!conference) return;
    setLines(current => { const next = { ...current }; for (const line of conference.lines) if (line.invoiceMatch) next[line.itemId] = { ...next[line.itemId], quantity: String(line.invoiceMatch.quantity ?? next[line.itemId].quantity), cost: String(line.invoiceMatch.unitValue ?? next[line.itemId].cost) }; return next; });
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await api<Result>(`/purchasing/orders/${order.id}/receive`, { method: 'POST', body: JSON.stringify({ ...(invoiceId ? { invoiceId } : {}), note: note || undefined, lines: order.items.map(item => ({ itemId: item.id, receivedQuantity: Number(lines[item.id].quantity), receivedUnitCost: Number(lines[item.id].cost), ...(lines[item.id].expiresAt ? { expiresAt: lines[item.id].expiresAt } : {}) })) }) });
      setResult(response);
    } catch (cause) { setError(errorMessage(cause, 'Erro ao receber a compra')); } finally { setBusy(false); }
  }

  if (result) return <section className={`${panelClass} mb-6`}>
    <h2 className="mb-2 text-lg font-semibold">Compra {order.code} recebida</h2>
    <p className="mb-3 text-sm">Pedido: <strong>{formatMoney(result.conference.orderedTotal)}</strong> · Recebido (a pagar): <strong>{formatMoney(result.conference.receivedTotal)}</strong></p>
    {result.conference.divergences.length === 0 ? <Notice kind="success" message="Tudo conferido: quantidades e preços iguais ao pedido." /> : <DataTable columns={[{ label: 'Item' }, { label: 'Divergência' }, { label: 'Detalhe' }]}>{result.conference.divergences.map((item, index) => <tr key={index}><td><strong>{item.name}</strong></td><td><Badge tone="amber">{kindLabel[item.kind] ?? item.kind}</Badge></td><td>{item.detail}</td></tr>)}</DataTable>}
    <button type="button" className={`${buttonClass} mt-4`} onClick={() => onDone(`Compra ${order.code} recebida e conferida.`)}>Concluir</button>
  </section>;

  return <section className={`${panelClass} mb-6`}>
    <h2 className="mb-1 text-lg font-semibold">Conferir e receber · {order.code}</h2>
    <p className="mb-4 text-sm text-slate-600">Informe o que realmente chegou. O estoque entra pelo recebido, o custo médio usa o preço da nota e a conta a pagar é gerada pelo valor recebido.</p>
    {error && <Notice message={error} />}
    <form onSubmit={submit}>
      <div className="mb-4 flex flex-wrap items-end gap-3"><div className="min-w-72"><Select label="Nota do fornecedor (XML importado, opcional)" value={invoiceId} onChange={event => { setInvoiceId(event.target.value); setConference(null); }}><option value="">Sem nota vinculada</option>{invoices.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.supplierName} · {formatMoney(invoice.totalAmount)}</option>)}</Select></div>
        {conference && <button type="button" className={secondaryButtonClass} onClick={applyInvoice} disabled={!conference.lines.some(line => line.invoiceMatch)}>Preencher com a nota ({conference.lines.filter(line => line.invoiceMatch).length} item(ns) reconhecido(s))</button>}</div>
      <DataTable columns={[{ label: 'Item' }, { label: 'Pedido' }, { label: 'Recebido' }, { label: 'Preço unit.' }, { label: 'Validade' }, { label: 'Nota' }]}>
        {order.items.map(item => { const match = conference?.lines.find(line => line.itemId === item.id)?.invoiceMatch; return <tr key={item.id}><td><strong>{item.ingredient.name}</strong></td><td>{Number(item.quantity)} {item.ingredient.unitOfMeasure} × {formatMoney(item.unitCost)}</td>
          <td><input aria-label={`Recebido de ${item.ingredient.name}`} type="number" min={0} step="0.001" required className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={lines[item.id].quantity} onChange={event => set(item.id, { quantity: event.target.value })} /></td>
          <td><input aria-label={`Preço de ${item.ingredient.name}`} type="number" min={0} step="0.0001" required className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={lines[item.id].cost} onChange={event => set(item.id, { cost: event.target.value })} /></td>
          <td><input aria-label={`Validade de ${item.ingredient.name}`} type="date" className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={lines[item.id].expiresAt} onChange={event => set(item.id, { expiresAt: event.target.value })} /></td>
          <td className="text-xs text-slate-600">{match ? `${match.description} · ${match.quantity ?? '?'} × ${match.unitValue === null ? '?' : formatMoney(match.unitValue)}` : invoiceId ? 'sem correspondência' : '—'}</td></tr>; })}
      </DataTable>
      <div className="mt-4 flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label="Observação do recebimento" maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></div><button className={buttonClass} disabled={busy}>{busy ? 'Recebendo…' : 'Confirmar recebimento'}</button><button type="button" className={secondaryButtonClass} onClick={onCancel}>Voltar</button></div>
    </form>
  </section>;
}

type Comparison = { ingredient: { name: string; unitOfMeasure: string }; suppliers: { supplierId: string; supplierName: string; purchases: number; lastCost: number; lastAt: string; averageCost: number; minCost: number; vsBest: number }[] };

// Compares what each supplier charged for an ingredient in received purchases (best last price first).
export function PriceComparison({ ingredients }: { ingredients: Ingredient[] }) {
  const [ingredientId, setIngredientId] = useState('');
  const [data, setData] = useState<{ id: string; value: Comparison } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ingredientId) return;
    let active = true;
    api<Comparison>(`/purchasing/price-comparison?ingredientId=${ingredientId}`).then(value => { if (active) { setError(''); setData({ id: ingredientId, value }); } }).catch(cause => { if (active) setError(errorMessage(cause, 'Falha ao comparar preços')); });
    return () => { active = false; };
  }, [ingredientId]);
  const current = data && data.id === ingredientId ? data.value : null;
  return <section className={`${panelClass} mb-6`}>
    <h2 className="mb-1 text-lg font-semibold">Comparação de preços entre fornecedores</h2>
    <p className="mb-4 text-sm text-slate-600">Baseada nas compras já recebidas (preço efetivamente praticado).</p>
    <div className="mb-4 max-w-sm"><Select label="Ingrediente" value={ingredientId} onChange={event => setIngredientId(event.target.value)}><option value="">Selecione</option>{ingredients.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
    {error && <Notice message={error} />}
    {current && (current.suppliers.length === 0 ? <p className="text-sm text-slate-600">Ainda não há compras recebidas deste ingrediente.</p> : <DataTable columns={[{ label: 'Fornecedor' }, { label: 'Último preço' }, { label: 'Menor / Médio' }, { label: 'Compras' }, { label: 'Diferença p/ melhor' }]}>
      {current.suppliers.map((row, index) => <tr key={row.supplierId}><td><strong>{row.supplierName}</strong> {index === 0 && <Badge tone="green">Melhor preço</Badge>}</td><td>{formatMoney(row.lastCost)} / {current.ingredient.unitOfMeasure}</td><td>{formatMoney(row.minCost)} / {formatMoney(row.averageCost)}</td><td>{row.purchases}</td><td>{row.vsBest === 0 ? '—' : `+${row.vsBest}%`}</td></tr>)}
    </DataTable>)}
  </section>;
}
