'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, type ListResponse, type Product } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, StatCard } from '../../components/ui';

type Comparison = {
  totals: { revenue: number; orders: number; avgTicket: number | null; expenses: number; result: number }; note: string;
  units: { unitId: string | null; name: string; revenue: number; orders: number; avgTicket: number | null; expenses: number; result: number; criticalStock: number; share: number }[];
};
type UnitPrice = { unitId: string; unit: string; price: string | number | null };
const firstOfMonth = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`; };

export default function NetworkPage() {
  const [range, setRange] = useState({ from: firstOfMonth(), to: new Date().toISOString().slice(0, 10) });
  const [data, setData] = useState<Comparison | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [prices, setPrices] = useState<{ basePrice: string | number; items: UnitPrice[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (cause: unknown, fallback: string) => setNotice({ text: errorMessage(cause, fallback), kind: 'error' });

  async function compare(period = range) {
    try { setData(await api<Comparison>(`/network/comparison?from=${period.from}T00:00:00&to=${period.to}T23:59:59`)); } catch (cause) { fail(cause, 'Falha ao carregar a comparação entre unidades'); }
  }
  useAutoLoad(async () => {
    await compare();
    try { setProducts((await api<ListResponse<Product>>('/products?pageSize=100')).items); } catch (cause) { fail(cause, 'Falha ao carregar os produtos'); }
  });

  async function pick(id: string) {
    setProductId(id); setPrices(null);
    if (!id) return;
    try {
      const result = await api<{ basePrice: string | number; items: UnitPrice[] }>(`/products/${id}/unit-prices`);
      setPrices(result); setDraft(Object.fromEntries(result.items.map(item => [item.unitId, item.price === null ? '' : String(item.price)])));
    } catch (cause) { fail(cause, 'Falha ao carregar os preços por unidade'); }
  }
  async function savePrice(unitId: string) {
    const raw = draft[unitId]?.trim() ?? '';
    try {
      await api(`/products/${productId}/unit-prices/${unitId}`, { method: 'PUT', body: JSON.stringify({ price: raw === '' ? null : Number(raw) }) });
      setNotice({ text: raw === '' ? 'Preço da unidade removido; vale o preço base.' : 'Preço da unidade salvo.', kind: 'success' }); await pick(productId);
    } catch (cause) { fail(cause, 'Falha ao salvar o preço'); }
  }

  return <AppShell title="Rede de unidades">
    <PageHeader title="Rede de unidades" subtitle="Indicadores consolidados e comparação entre unidades, além de preços específicos por unidade. Disponível para quem não está vinculado a uma única unidade." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="De" type="date" value={range.from} onChange={event => setRange({ ...range, from: event.target.value })} />
        <Field label="Até" type="date" value={range.to} onChange={event => setRange({ ...range, to: event.target.value })} />
        <button type="button" className={buttonClass} onClick={() => void compare()}>Comparar</button>
      </div>
      {!data ? <EmptyState title="Sem dados" /> : <>
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <StatCard label="Faturamento consolidado" value={formatMoney(data.totals.revenue)} />
          <StatCard label="Pedidos" value={data.totals.orders} />
          <StatCard label="Despesas pagas" value={formatMoney(data.totals.expenses)} />
          <StatCard label="Resultado" value={formatMoney(data.totals.result)} />
        </div>
        <DataTable columns={[{ label: 'Unidade' }, { label: 'Faturamento' }, { label: '% da rede' }, { label: 'Pedidos' }, { label: 'Ticket médio' }, { label: 'Despesas' }, { label: 'Resultado' }, { label: 'Estoque crítico' }]}>
          {data.units.map(unit => <tr key={unit.unitId ?? 'none'}><td>{unit.name}</td><td>{formatMoney(unit.revenue)}</td><td>{unit.share}%</td><td>{unit.orders}</td><td>{unit.avgTicket === null ? '—' : formatMoney(unit.avgTicket)}</td><td>{formatMoney(unit.expenses)}</td><td className="font-semibold">{formatMoney(unit.result)}</td><td>{unit.criticalStock}</td></tr>)}
        </DataTable>
        <p className="mt-2 text-xs text-slate-500">{data.note}</p>
      </>}
    </section>
    <section className={panelClass}>
      <h2 className="mb-3 text-base font-bold">Preço por unidade</h2>
      <Select label="Produto" value={productId} onChange={event => void pick(event.target.value)}><option value="">Selecione</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select>
      {prices && <div className="mt-3 space-y-2">
        <p className="text-xs text-slate-500">Preço base: {formatMoney(prices.basePrice)}. Deixe em branco para usar o preço base.</p>
        {prices.items.map(item => <div key={item.unitId} className="flex flex-wrap items-end gap-2">
          <Field label={item.unit} type="number" min={0} step="0.01" value={draft[item.unitId] ?? ''} onChange={event => setDraft({ ...draft, [item.unitId]: event.target.value })} />
          <button type="button" className={secondaryButtonClass} onClick={() => void savePrice(item.unitId)}>Salvar</button>
        </div>)}
      </div>}
    </section>
  </AppShell>;
}
