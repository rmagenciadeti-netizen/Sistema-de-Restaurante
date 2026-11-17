'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, StatCard } from '../../components/ui';
import { invoiceStatusLabel, type Reconciliation } from '../../lib/types-fiscal';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const docLabel: Record<string, string> = { AUTHORIZED: 'Autorizados', PENDING: 'Pendentes', REJECTED: 'Rejeitados', CANCELLED: 'Cancelados' };

export default function ReconciliationPage() {
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const [data, setData] = useState<Reconciliation | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);

  async function load() {
    setNotice(null);
    const params = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() });
    try { setData(await api<Reconciliation>(`/fiscal-registry/reconciliation?${params}`)); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar a conciliação'), kind: 'error' }); }
  }
  useAutoLoad(load);

  return <AppShell title="Conciliação tributária">
    <PageHeader title="Conciliação tributária" subtitle="Confronta os pedidos concluídos com os documentos fiscais autorizados no período e aponta o que ficou sem nota. É uma conferência gerencial; não substitui a apuração do contador." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void load(); }}>
      <div className="w-44"><Field label="De" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></div>
      <div className="w-44"><Field label="Até" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
      <button className={buttonClass}>Conciliar</button>
    </form>
    {data && <>
      {data.truncated && <Notice message="Período com mais de 5.000 pedidos: o resultado considera apenas os mais recentes. Reduza o intervalo." kind="error" />}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Pedidos concluídos" value={data.orders.count} hint={formatMoney(data.orders.total)} />
        <StatCard label="Com documento autorizado" value={data.invoiced.count} hint={formatMoney(data.invoiced.total)} />
        <StatCard label="Sem documento autorizado" value={data.withoutDocument.count} hint={formatMoney(data.withoutDocument.total)} tone={data.withoutDocument.count > 0 ? 'dark' : 'default'} />
        <StatCard label="Documentos no período" value={Object.values(data.documentsByStatus).reduce((sum, value) => sum + value, 0)} hint={Object.entries(data.documentsByStatus).map(([key, value]) => `${docLabel[key] ?? key}: ${value}`).join(' · ') || 'Nenhum'} />
      </div>
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Pedidos sem documento autorizado</h2>
      {data.withoutDocument.items.length === 0 ? <div className="mb-6"><EmptyState icon="✅" title="Tudo conciliado" hint="Todos os pedidos concluídos do período possuem documento autorizado." /></div> :
        <div className="mb-6"><DataTable columns={[{ label: 'Pedido' }, { label: 'Data' }, { label: 'Total' }]} footer={<>{data.withoutDocument.count > data.withoutDocument.items.length ? `Mostrando ${data.withoutDocument.items.length} de ${data.withoutDocument.count}. ` : ''}<Link className="font-medium text-brand-700 underline" href="/fiscal">Emitir em Documentos fiscais</Link></>}>
          {data.withoutDocument.items.map(order => <tr key={order.id}><td className="font-medium text-slate-900">{order.code}</td><td>{formatDateTime(order.createdAt)}</td><td>{formatMoney(order.total)}</td></tr>)}
        </DataTable></div>}
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Notas de fornecedores no período</h2>
      {Object.keys(data.receivedByStatus).length === 0 ? <EmptyState icon="📥" title="Nenhuma nota recebida" hint="Registre notas em Entrada de NF-e." /> :
        <DataTable columns={[{ label: 'Situação' }, { label: 'Notas' }, { label: 'Total' }]}>
          {Object.entries(data.receivedByStatus).map(([key, value]) => <tr key={key}><td className="font-medium text-slate-900">{invoiceStatusLabel[key as keyof typeof invoiceStatusLabel] ?? key}</td><td>{value.count}</td><td>{formatMoney(value.total)}</td></tr>)}
        </DataTable>}
    </>}
  </AppShell>;
}
