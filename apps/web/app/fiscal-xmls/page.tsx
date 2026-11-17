'use client';

import { useState } from 'react';
import { api, errorMessage, FiscalDocument, formatDateTime, formatMoney, ListResponse, saveText } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs } from '../../components/ui';
import { EnvironmentBanner, exportXmlZip, FiscalStatusBadges, makePeriod, modelLabel, Period, PeriodFilter, PeriodKey, setPeriodParams, useFiscalSettings, XmlFile, XmlModal } from '../../components/fiscal-common';
import { environmentLabel, fiscalStatusLabel, invoiceStatusLabel, kindLabel, type FiscalEnvironment, type XmlsResponse } from '../../lib/types-fiscal';

type TabKey = 'received' | 'emitted';
const tabs: { key: TabKey; label: string }[] = [{ key: 'received', label: 'Recebidos (XML armazenado)' }, { key: 'emitted', label: 'Emitidos' }];
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export default function FiscalXmlsPage() {
  const { settings, error: settingsError } = useFiscalSettings();
  const [tab, setTab] = useState<TabKey>('received');
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  // ---------- Recebidos ----------
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const [data, setData] = useState<XmlsResponse>({ received: [], emitted: [] }); const [loaded, setLoaded] = useState(false);
  async function load() {
    setNotice(null);
    const params = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() });
    try { setData(await api<XmlsResponse>(`/fiscal-registry/xmls?${params}`)); } catch (e) { fail(e, 'Erro ao carregar XMLs'); } finally { setLoaded(true); }
  }
  useAutoLoad(load);
  async function download(id: string) {
    try { const file = await api<{ accessKey: string; xml: string }>(`/fiscal-registry/invoices/${id}/xml`); saveText(file.xml, `${file.accessKey}.xml`); } catch (e) { fail(e, 'Erro ao baixar XML'); }
  }
  async function downloadAll() { for (const invoice of data.received) await download(invoice.id); }

  // ---------- Emitidos ----------
  const [filters, setFilters] = useState({ period: makePeriod('month') as Period, kind: '', status: '', environment: '', series: '', q: '' });
  const [documents, setDocuments] = useState<FiscalDocument[]>([]); const [loadedEmitted, setLoadedEmitted] = useState(false);
  const [selected, setSelected] = useState<string[]>([]); const [withEvents, setWithEvents] = useState(true);
  const [xmlView, setXmlView] = useState<XmlFile | null>(null); const [busy, setBusy] = useState(false);
  const environment = (filters.environment || settings?.environment || '') as FiscalEnvironment | '';

  function listParams(period: Period, onlyPeriod = false) {
    const params = setPeriodParams(new URLSearchParams(), period);
    if (environment) params.set('environment', environment);
    if (onlyPeriod) return params;
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.status) params.set('status', filters.status);
    if (filters.q.trim()) params.set('q', filters.q.trim());
    return params;
  }
  async function loadEmitted() {
    const params = listParams(filters.period); params.set('take', '500');
    try { setDocuments((await api<ListResponse<FiscalDocument>>(`/fiscal/documents?${params}`)).items); setSelected([]); } catch (e) { fail(e, 'Erro ao carregar documentos emitidos'); } finally { setLoadedEmitted(true); }
  }
  function changeTab(key: TabKey) { setTab(key); if (key === 'emitted' && !loadedEmitted) void loadEmitted(); }

  const visible = documents.filter(doc => !filters.series.trim() || doc.series === filters.series.trim());
  const withXml = visible.filter(doc => doc.hasXml);
  const allSelected = withXml.length > 0 && withXml.every(doc => selected.includes(doc.id));

  async function runExport(params: URLSearchParams) {
    setNotice(null); setBusy(true);
    params.set('events', String(withEvents));
    if (!params.has('environment') && environment) params.set('environment', environment);
    try { setNotice({ text: await exportXmlZip(params), kind: 'success' }); } catch (e) { fail(e, 'Erro ao exportar XML'); } finally { setBusy(false); }
  }
  function exportSelected() {
    const environments = Array.from(new Set(documents.filter(doc => selected.includes(doc.id)).map(doc => doc.environment)));
    if (environments.length > 1) { setNotice({ text: 'A seleção mistura homologação e produção. Exporte um ambiente por vez.', kind: 'error' }); return; }
    void runExport(new URLSearchParams({ ids: selected.join(','), ...(environments[0] ? { environment: environments[0] } : {}) }));
  }
  function exportFiltered() {
    // The export endpoint has no series filter: when it is set, the visible documents are exported by id.
    if (filters.series.trim()) { void runExport(new URLSearchParams({ ids: withXml.slice(0, 1000).map(doc => doc.id).join(','), ...(environment ? { environment } : {}) })); return; }
    void runExport(listParams(filters.period));
  }
  const quickExport = (key: PeriodKey) => void runExport(listParams(makePeriod(key), true));
  async function xml(doc: FiscalDocument, mode: 'view' | 'save') {
    try { const file = await api<XmlFile>(`/fiscal/documents/${doc.id}/xml`); if (mode === 'save') saveText(file.xml, file.fileName); else setXmlView(file); } catch (e) { fail(e, 'Erro ao obter o XML'); }
  }

  return <AppShell title="XMLs">
    <PageHeader title="XMLs" subtitle="XMLs das notas recebidas e dos documentos fiscais emitidos (NFC-e/NF-e e seus eventos), exatamente como foram autorizados." />
    <EnvironmentBanner settings={settings} error={settingsError} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <Tabs tabs={tabs} value={tab} onChange={changeTab} label="Origem dos XMLs" />

    {tab === 'received' && <>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void load(); }}>
        <div className="w-44"><Field label="De" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></div>
        <div className="w-44"><Field label="Até" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
        <button className={buttonClass}>Filtrar</button>
        {data.received.length > 0 && <button type="button" className={secondaryButtonClass} onClick={() => void downloadAll()}>Baixar todos ({data.received.length})</button>}
      </form>
      {loaded && data.received.length === 0 ? <EmptyState icon="🧩" title="Nenhum XML recebido no período" hint="XMLs aparecem aqui quando a nota é registrada em Entrada de NF-e com o arquivo anexado." /> :
        <DataTable columns={[{ label: 'Nota' }, { label: 'Fornecedor' }, { label: 'Emissão' }, { label: 'Total' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${data.received.length} XML(s)`}>
          {data.received.map(row => <tr key={row.id}><td className="font-medium text-slate-900">{row.number}<span className="block max-w-48 truncate text-xs font-normal text-slate-500" title={row.accessKey}>{row.accessKey}</span></td><td>{row.supplierName}</td><td>{formatDateTime(row.issuedAt).slice(0, 10)}</td><td>{formatMoney(row.totalAmount)}</td><td>{invoiceStatusLabel[row.status]}</td><td className="text-right"><button className={secondaryButtonClass} onClick={() => void download(row.id)}>Baixar XML</button></td></tr>)}
        </DataTable>}
    </>}

    {tab === 'emitted' && <>
      <form className={`${panelClass} mb-4 grid gap-3`} onSubmit={event => { event.preventDefault(); void loadEmitted(); }}>
        <PeriodFilter value={filters.period} onChange={period => setFilters({ ...filters, period })} />
        <div className="grid gap-3 md:grid-cols-6">
          <Select label="Ambiente" value={environment} onChange={e => setFilters({ ...filters, environment: e.target.value })}><option value="PRODUCTION">Produção</option><option value="HOMOLOGATION">Homologação</option></Select>
          <Select label="Modelo" value={filters.kind} onChange={e => setFilters({ ...filters, kind: e.target.value })}><option value="">Todos</option><option value="NFCE">{kindLabel.NFCE}</option><option value="NFE">{kindLabel.NFE}</option></Select>
          <Select label="Situação" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">Todas</option>{Object.entries(fiscalStatusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
          <Field label="Série" inputMode="numeric" maxLength={3} value={filters.series} onChange={e => setFilters({ ...filters, series: e.target.value })} />
          <div className="md:col-span-2"><Field label="Número, chave, cliente ou CPF/CNPJ" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={buttonClass}>Filtrar</button>
          <button type="button" className={secondaryButtonClass} disabled={busy || selected.length === 0} onClick={exportSelected}>Baixar selecionados (ZIP) ({selected.length})</button>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={exportFiltered}>Exportar período (ZIP)</button>
          <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden="true" />
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => quickExport('today')}>XML do dia</button>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => quickExport('week')}>XML da semana</button>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => quickExport('month')}>XML do mês</button>
          <Check label="Incluir eventos (cancelamento, CC-e, inutilização)" checked={withEvents} onChange={e => setWithEvents(e.target.checked)} />
        </div>
        <p className="text-xs text-slate-500">Homologação e produção nunca são misturadas: a exportação usa somente o ambiente selecionado ({environment ? environmentLabel[environment] : '—'}). Os arquivos são os XMLs originais autorizados, sem nenhuma alteração, organizados por ambiente, modelo e mês.</p>
      </form>
      {loadedEmitted && visible.length === 0 ? <EmptyState icon="🧾" title="Nenhum documento emitido com esses filtros" hint="Ajuste o período, o ambiente ou a busca." /> :
        <DataTable columns={[{ label: '' }, { label: 'Documento' }, { label: 'Data' }, { label: 'Pedido / cliente' }, { label: 'Valor' }, { label: 'Ambiente' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${visible.length} documento(s) · ${withXml.length} com XML · ${selected.length} selecionado(s)`}>
          <tr className="bg-slate-50"><td><input type="checkbox" aria-label="Selecionar todos com XML" className="h-4 w-4 accent-brand-600" checked={allSelected} onChange={() => setSelected(allSelected ? [] : withXml.map(doc => doc.id))} /></td><td colSpan={7} className="text-xs text-slate-500">Selecionar todos os exibidos com XML</td></tr>
          {visible.map(doc => <tr key={doc.id}>
            <td><input type="checkbox" aria-label={`Selecionar ${doc.number ?? doc.id}`} className="h-4 w-4 accent-brand-600" disabled={!doc.hasXml} checked={selected.includes(doc.id)} onChange={() => setSelected(current => (current.includes(doc.id) ? current.filter(id => id !== doc.id) : [...current, doc.id]))} /></td>
            <td className="font-medium text-slate-900">{modelLabel[doc.kind]}{doc.number ? ` nº ${doc.number}` : ''}{doc.series ? ` · série ${doc.series}` : ''}{doc.accessKey && <span className="block max-w-52 truncate font-mono text-[11px] font-normal text-slate-500" title={doc.accessKey}>{doc.accessKey}</span>}</td>
            <td className="text-xs">{formatDateTime(doc.createdAt)}</td>
            <td>{doc.order?.code ?? '—'}<span className="block text-xs text-slate-500">{doc.order?.customer?.name ?? doc.order?.customerName ?? 'Consumidor'}{doc.order?.customer?.document ? ` · ${doc.order.customer.document}` : ''}</span></td>
            <td className="whitespace-nowrap">{doc.order ? formatMoney(doc.order.total) : '—'}</td>
            <td><Badge tone={doc.environment === 'PRODUCTION' ? 'green' : 'amber'}>{environmentLabel[doc.environment]}</Badge></td>
            <td><FiscalStatusBadges status={doc.status} contingency={doc.contingency} /></td>
            <td className="text-right">{doc.hasXml ? <span className="inline-flex gap-1"><button type="button" className={secondaryButtonClass} onClick={() => void xml(doc, 'view')}>Visualizar</button><button type="button" className={secondaryButtonClass} onClick={() => void xml(doc, 'save')}>Baixar XML</button></span> : <span className="text-xs text-slate-500">Sem XML</span>}</td>
          </tr>)}
        </DataTable>}
    </>}
    {xmlView && <XmlModal file={xmlView} onClose={() => setXmlView(null)} />}
  </AppShell>;
}
