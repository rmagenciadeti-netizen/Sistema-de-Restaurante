'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs } from '../../components/ui';
import { invoiceStatusLabel, type XmlsResponse } from '../../lib/types-fiscal';

type TabKey = 'received' | 'emitted';
const tabs: { key: TabKey; label: string }[] = [{ key: 'received', label: 'Recebidos (XML armazenado)' }, { key: 'emitted', label: 'Emitidos (provedor fiscal)' }];
const kindLabel: Record<string, string> = { NFCE: 'NFC-e', NFE: 'NF-e' };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export default function FiscalXmlsPage() {
  const [tab, setTab] = useState<TabKey>('received');
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const [data, setData] = useState<XmlsResponse>({ received: [], emitted: [] }); const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    setNotice(null);
    const params = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() });
    try { setData(await api<XmlsResponse>(`/fiscal-registry/xmls?${params}`)); } catch (e) { fail(e, 'Erro ao carregar XMLs'); } finally { setLoaded(true); }
  }
  useAutoLoad(load);

  async function download(id: string) {
    try {
      const file = await api<{ accessKey: string; xml: string }>(`/fiscal-registry/invoices/${id}/xml`);
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([file.xml], { type: 'application/xml' })); link.download = `${file.accessKey}.xml`; link.click(); URL.revokeObjectURL(link.href);
    } catch (e) { fail(e, 'Erro ao baixar XML'); }
  }
  async function downloadAll() {
    for (const invoice of data.received) await download(invoice.id);
  }

  return <AppShell title="XMLs">
    <PageHeader title="XMLs" subtitle="XMLs das notas recebidas guardados no sistema e links dos documentos emitidos pelo provedor fiscal. O sistema não gera nem assina XML próprio." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void load(); }}>
      <div className="w-44"><Field label="De" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></div>
      <div className="w-44"><Field label="Até" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
      <button className={buttonClass}>Filtrar</button>
      {tab === 'received' && data.received.length > 0 && <button type="button" className={secondaryButtonClass} onClick={() => void downloadAll()}>Baixar todos ({data.received.length})</button>}
    </form>
    <Tabs tabs={tabs} value={tab} onChange={setTab} label="Origem dos XMLs" />
    {tab === 'received' && (loaded && data.received.length === 0 ? <EmptyState icon="🧩" title="Nenhum XML recebido no período" hint="XMLs aparecem aqui quando a nota é registrada em Entrada de NF-e com o arquivo anexado." /> :
      <DataTable columns={[{ label: 'Nota' }, { label: 'Fornecedor' }, { label: 'Emissão' }, { label: 'Total' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${data.received.length} XML(s)`}>
        {data.received.map(row => <tr key={row.id}><td className="font-medium text-slate-900">{row.number}<span className="block max-w-48 truncate text-xs font-normal text-slate-500" title={row.accessKey}>{row.accessKey}</span></td><td>{row.supplierName}</td><td>{formatDateTime(row.issuedAt).slice(0, 10)}</td><td>{formatMoney(row.totalAmount)}</td><td>{invoiceStatusLabel[row.status]}</td><td className="text-right"><button className={secondaryButtonClass} onClick={() => void download(row.id)}>Baixar XML</button></td></tr>)}
      </DataTable>)}
    {tab === 'emitted' && (loaded && data.emitted.length === 0 ? <EmptyState icon="🧾" title="Nenhum documento emitido no período" hint="Documentos autorizados ou cancelados pelo provedor fiscal aparecem aqui." /> :
      <DataTable columns={[{ label: 'Documento' }, { label: 'Pedido' }, { label: 'Data' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${data.emitted.length} documento(s)`}>
        {data.emitted.map(row => <tr key={row.id}><td className="font-medium text-slate-900">{kindLabel[row.kind] ?? row.kind} {row.number ?? ''}{row.accessKey && <span className="block max-w-48 truncate text-xs font-normal text-slate-500" title={row.accessKey}>{row.accessKey}</span>}</td><td>{row.order ? `${row.order.code} — ${formatMoney(row.order.total)}` : '—'}</td><td>{formatDateTime(row.createdAt)}</td><td><Badge tone={row.status === 'AUTHORIZED' ? 'green' : 'neutral'}>{row.status === 'AUTHORIZED' ? 'Autorizado' : 'Cancelado'}</Badge></td><td className="text-right">{row.documentUrl ? <a className={secondaryButtonClass} href={row.documentUrl} target="_blank" rel="noopener noreferrer">Abrir no provedor</a> : <span className="text-xs text-slate-500">Sem link</span>}</td></tr>)}
      </DataTable>)}
  </AppShell>;
}
