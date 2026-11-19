'use client';

import { useState } from 'react';
import Link from '../../components/nav-link';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, textareaClass } from '../../components/ui';
import { BatchResponse, BatchResults, dayEndIso, dayStartIso, EnvironmentBanner, exportXmlZip, FiscalStatusBadges, modelLabel, Period, PeriodFilter, useFiscalSettings } from '../../components/fiscal-common';
import { environmentLabel, fiscalStatusLabel, kindLabel, type ContingencyResponse, type Inutilization } from '../../lib/types-fiscal';

type Kind = 'NFCE' | 'NFE';
type Pending = ContingencyResponse['pending'][number];
const pendingStatuses = ['PENDING', 'PROCESSING', 'CONTINGENCY', 'REJECTED'];
const emptyInutilization = { kind: 'NFCE' as Kind, series: '1', numberFrom: '', numberTo: '', justification: '' };

export default function ContingencyPage() {
  const { settings, error: settingsError } = useFiscalSettings();
  const [data, setData] = useState<ContingencyResponse | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });
  const [filters, setFilters] = useState({ status: '', kind: '', environment: '', period: { key: 'custom', from: '', to: '' } as Period });
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<{ title: string; data: BatchResponse; labels: Record<string, string> } | null>(null);
  const [series, setSeries] = useState<Record<Kind, string>>({ NFCE: '1', NFE: '1' });
  const [inutilizations, setInutilizations] = useState<Inutilization[]>([]);
  const [inut, setInut] = useState(emptyInutilization);

  async function loadPending() { try { setData(await api<ContingencyResponse>('/fiscal-registry/contingency')); } catch (e) { fail(e, 'Erro ao carregar contingências'); } }
  async function loadInutilizations() { try { setInutilizations((await api<{ items: Inutilization[] }>('/fiscal/inutilizations')).items); } catch (e) { fail(e, 'Erro ao carregar inutilizações'); } }
  async function load() {
    await Promise.all([loadPending(), loadInutilizations(), api<{ items: { kind: Kind; series: string }[] }>('/fiscal/numbering').then(numbering => {
      const next = numbering.items.reduce((acc, item) => ({ ...acc, [item.kind]: item.series }), { NFCE: '1', NFE: '1' } as Record<Kind, string>);
      setSeries(next); setInut(current => ({ ...current, series: next[current.kind] }));
    }).catch(() => undefined)]);
  }
  useAutoLoad(load);

  async function run(path: 'start' | 'end', body?: unknown, success?: string) {
    setNotice(null); setBusy(true);
    try { await api(`/fiscal-registry/contingency/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); setReason(''); setNotice({ text: success ?? 'Atualizado.', kind: 'success' }); await loadPending(); } catch (e) { fail(e, 'Erro ao atualizar contingência'); } finally { setBusy(false); }
  }

  const pending = data?.pending ?? [];
  const visible = pending.filter(row => (!filters.status || row.status === filters.status) && (!filters.kind || row.kind === filters.kind) && (!filters.environment || row.environment === filters.environment)
    && (!filters.period.from || row.createdAt >= dayStartIso(filters.period.from)) && (!filters.period.to || row.createdAt <= dayEndIso(filters.period.to)));
  const label = (row: Pending) => `${modelLabel[row.kind] ?? row.kind}${row.number ? ` nº ${row.number}` : ''}${row.series ? ` · série ${row.series}` : ''}${row.order ? ` (${row.order.code})` : ''}`;
  const allVisibleSelected = visible.length > 0 && visible.every(row => selected.includes(row.id));
  const toggle = (id: string) => setSelected(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));

  // The API accepts up to 50 ids per call: larger selections are sent in sequential chunks.
  async function batchRun(kind: 'transmit' | 'consult', ids?: string[]) {
    setNotice(null); setBusy(true);
    const labels = Object.fromEntries(pending.map(row => [row.id, label(row)]));
    const title = kind === 'transmit' ? 'Envio' : 'Consulta';
    try {
      const chunks = ids ? Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, index * 50 + 50)) : [undefined];
      const merged: BatchResponse = { processed: 0, results: [] };
      for (const chunk of chunks) {
        const result = await api<BatchResponse>(`/fiscal/documents/${kind}`, { method: 'POST', body: JSON.stringify(chunk ? { ids: chunk } : {}) });
        merged.processed += result.processed; merged.results.push(...result.results);
      }
      setBatch({ title, data: merged, labels }); setSelected([]);
    } catch (e) { fail(e, `Erro na ${title.toLowerCase()} em lote`); } finally { setBusy(false); await loadPending(); }
  }
  async function exportSelected() {
    const rows = pending.filter(row => selected.includes(row.id));
    const environments = Array.from(new Set(rows.map(row => row.environment)));
    if (environments.length > 1) { setNotice({ text: 'A seleção mistura homologação e produção. Exporte um ambiente por vez.', kind: 'error' }); return; }
    setNotice(null); setBusy(true);
    try { setNotice({ text: await exportXmlZip(new URLSearchParams({ ids: rows.map(row => row.id).join(','), environment: environments[0] ?? settings?.environment ?? 'HOMOLOGATION' })), kind: 'success' }); } catch (e) { fail(e, 'Erro ao exportar XML'); } finally { setBusy(false); }
  }

  async function inutilize(event: React.FormEvent) {
    event.preventDefault();
    const from = Number(inut.numberFrom); const to = Number(inut.numberTo);
    if (to < from) { setNotice({ text: 'O número final deve ser maior ou igual ao inicial.', kind: 'error' }); return; }
    if (!window.confirm(`Inutilizar os números ${from} a ${to} da ${modelLabel[inut.kind]} série ${inut.series} em ${settings ? environmentLabel[settings.environment] : 'ambiente atual'}?\n\nA inutilização é registrada na SEFAZ e é IRREVERSÍVEL: esses números nunca poderão ser usados.`)) return;
    setNotice(null); setBusy(true);
    try {
      const result = await api<{ protocol?: string | null }>('/fiscal/inutilizations', { method: 'POST', body: JSON.stringify({ kind: inut.kind, series: inut.series.trim(), numberFrom: from, numberTo: to, justification: inut.justification.trim() }) });
      setNotice({ text: `Numeração ${from}–${to} inutilizada${result.protocol ? ` — protocolo ${result.protocol}` : ''}.`, kind: 'success' });
      setInut({ ...emptyInutilization, kind: inut.kind, series: series[inut.kind] });
    } catch (e) { fail(e, 'Erro ao inutilizar a numeração'); } finally { setBusy(false); await loadInutilizations(); }
  }

  const columns = [{ label: '' }, ...['Documento', 'Data', 'Cliente', 'Valor', 'Ambiente', 'Situação', 'Protocolo', 'Última tentativa', 'Mensagem'].map(text => ({ label: text }))];
  const justification = inut.justification.trim().length;

  return <AppShell title="Contingências">
    <PageHeader title="Contingências" subtitle="Registre os períodos sem comunicação com a SEFAZ/provedor fiscal, regularize os documentos pendentes e inutilize faixas de numeração não utilizadas." actions={<Link className={secondaryButtonClass} href="/fiscal">Documentos fiscais</Link>} />
    <EnvironmentBanner settings={settings} error={settingsError} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      {data?.active ? <div className="flex flex-wrap items-center justify-between gap-4">
        <div><Badge tone="amber">Contingência em andamento</Badge><p className="mt-2 text-sm text-slate-700">Desde {formatDateTime(data.active.startedAt)} — {data.active.reason}</p></div>
        <button className={buttonClass} disabled={busy} onClick={() => void run('end', undefined, 'Contingência encerrada.')}>{busy ? 'Encerrando...' : 'Encerrar contingência'}</button>
      </div> : <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void run('start', { reason: reason.trim() }, 'Contingência registrada.'); }}>
        <div className="min-w-72 flex-1"><Field label={`Motivo (${reason.trim().length}/15 mín.)`} required minLength={15} maxLength={255} placeholder="Ex.: provedor fiscal fora do ar desde as 10h" value={reason} onChange={e => setReason(e.target.value)} /></div>
        <button className={buttonClass} disabled={busy || reason.trim().length < 15}>{busy ? 'Registrando...' : 'Iniciar contingência'}</button>
      </form>}
    </section>

    <h2 className="mb-2 text-lg font-semibold text-slate-900">Documentos pendentes de regularização ({pending.length})</h2>
    <p className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">Documentos <strong>sem protocolo</strong> são sempre consultados na SEFAZ antes de qualquer reenvio: se já tiverem sido autorizados, apenas o retorno é registrado. O número e a série de cada documento <strong>nunca mudam</strong> — o reenvio usa o mesmo conteúdo da emissão original.</p>
    <div className={`${panelClass} mb-3 grid gap-3`}>
      <PeriodFilter value={filters.period} onChange={period => setFilters({ ...filters, period })} />
      <div className="grid gap-3 md:grid-cols-3">
        <Select label="Situação" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">Todas</option>{pendingStatuses.map(status => <option key={status} value={status}>{fiscalStatusLabel[status]}</option>)}</Select>
        <Select label="Modelo" value={filters.kind} onChange={e => setFilters({ ...filters, kind: e.target.value })}><option value="">Todos</option><option value="NFCE">{kindLabel.NFCE}</option><option value="NFE">{kindLabel.NFE}</option></Select>
        <Select label="Ambiente" value={filters.environment} onChange={e => setFilters({ ...filters, environment: e.target.value })}><option value="">Todos</option><option value="PRODUCTION">Produção</option><option value="HOMOLOGATION">Homologação</option></Select>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy || selected.length === 0} onClick={() => void batchRun('transmit', selected)}>Enviar selecionados ({selected.length})</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void batchRun('transmit')}>Reenviar todos os pendentes</button>
        <button type="button" className={secondaryButtonClass} disabled={busy || selected.length === 0} onClick={() => void batchRun('consult', selected)}>Consultar selecionados</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void batchRun('consult')}>Consultar todos os pendentes</button>
        <button type="button" className={secondaryButtonClass} disabled={busy || selected.length === 0} onClick={() => void exportSelected()}>Exportar XML</button>
      </div>
      <p className="text-xs text-slate-500">&quot;Todos os pendentes&quot; considera os documentos do ambiente fiscal atual.</p>
    </div>
    {batch && <BatchResults title={batch.title} data={batch.data} describe={id => batch.labels[id] ?? id} onClose={() => setBatch(null)} />}
    {data && visible.length === 0 ? <div className="mb-6"><EmptyState icon="✅" title="Nenhum documento pendente" hint="Documentos sem protocolo, em contingência ou rejeitados aparecem aqui." /></div> :
      <div className="mb-6"><DataTable columns={columns} footer={`${visible.length} de ${pending.length} documento(s) · ${selected.length} selecionado(s)`}>
        <tr className="bg-slate-50"><td><input type="checkbox" aria-label="Selecionar todos" className="h-4 w-4 accent-brand-600" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? selected.filter(id => !visible.some(row => row.id === id)) : Array.from(new Set([...selected, ...visible.map(row => row.id)])))} /></td><td colSpan={columns.length - 1} className="text-xs text-slate-500">Selecionar todos os exibidos</td></tr>
        {visible.map(row => <tr key={row.id} className="align-top">
          <td><input type="checkbox" aria-label={`Selecionar ${label(row)}`} className="h-4 w-4 accent-brand-600" checked={selected.includes(row.id)} onChange={() => toggle(row.id)} /></td>
          <td className="font-medium text-slate-900">{modelLabel[row.kind] ?? row.kind}{row.number ? ` nº ${row.number}` : ''}<span className="block text-xs font-normal text-slate-500">{row.series ? `Série ${row.series}` : 'Sem série'}{row.order ? ` · ${row.order.code}` : ''}</span></td>
          <td className="text-xs">{formatDateTime(row.createdAt)}</td>
          <td>{row.order?.customerName || 'Consumidor'}</td>
          <td className="whitespace-nowrap">{row.order ? formatMoney(row.order.total) : '—'}</td>
          <td><Badge tone={row.environment === 'PRODUCTION' ? 'green' : 'amber'}>{environmentLabel[row.environment]}</Badge></td>
          <td><FiscalStatusBadges status={row.status} contingency={row.contingency} /></td>
          <td className="font-mono text-xs">{row.protocol ?? '—'}</td>
          <td className="text-xs">{formatDateTime(row.lastAttemptAt)}{row.attempts > 0 && <span className="block text-slate-500">{row.attempts} tentativa(s)</span>}</td>
          <td className="max-w-64 text-xs text-slate-600">{row.error || '—'}</td>
        </tr>)}
      </DataTable></div>}

    <h2 className="mb-3 text-lg font-semibold text-slate-900">Inutilização de numeração</h2>
    <section className={`${panelClass} mb-4`}>
      <p className="mb-4 text-sm text-slate-500">Use quando uma faixa de números foi pulada e nunca será utilizada (ex.: falha antes da transmissão). Números já usados por qualquer documento não podem ser inutilizados. A operação é registrada na SEFAZ no ambiente atual e não pode ser desfeita.</p>
      <form className="grid gap-4 md:grid-cols-4" onSubmit={event => void inutilize(event)}>
        <Select label="Modelo" value={inut.kind} onChange={e => { const kind = e.target.value as Kind; setInut({ ...inut, kind, series: series[kind] }); }}><option value="NFCE">{kindLabel.NFCE}</option><option value="NFE">{kindLabel.NFE}</option></Select>
        <Field label="Série" required inputMode="numeric" pattern="\d{1,3}" maxLength={3} value={inut.series} onChange={e => setInut({ ...inut, series: e.target.value })} />
        <Field label="Número inicial" required type="number" min="1" step="1" value={inut.numberFrom} onChange={e => setInut({ ...inut, numberFrom: e.target.value })} />
        <Field label="Número final" required type="number" min={inut.numberFrom || '1'} step="1" value={inut.numberTo} onChange={e => setInut({ ...inut, numberTo: e.target.value })} />
        <label className="block text-sm font-medium text-slate-700 md:col-span-4">Justificativa <span className={justification >= 15 && justification <= 255 ? 'text-emerald-700' : 'text-slate-500'}>({justification}/15–255)</span>
          <textarea className={textareaClass} rows={2} required minLength={15} maxLength={255} value={inut.justification} onChange={e => setInut({ ...inut, justification: e.target.value })} placeholder="Ex.: numeração pulada por falha do sistema antes da transmissão" /></label>
        <div className="md:col-span-4"><button className={buttonClass} disabled={busy || justification < 15 || !inut.numberFrom || !inut.numberTo}>Inutilizar numeração</button></div>
      </form>
    </section>
    <div className="mb-6">{inutilizations.length === 0 ? <EmptyState icon="🔢" title="Nenhuma inutilização registrada" /> :
      <DataTable columns={['Data', 'Ambiente', 'Modelo', 'Série', 'Faixa', 'Protocolo', 'Situação', 'Justificativa / mensagem'].map(text => ({ label: text }))} footer={`${inutilizations.length} registro(s)`}>
        {inutilizations.map(row => <tr key={row.id} className="align-top"><td className="text-xs">{formatDateTime(row.createdAt)}</td><td><Badge tone={row.environment === 'PRODUCTION' ? 'green' : 'amber'}>{environmentLabel[row.environment]}</Badge></td><td>{modelLabel[row.kind]}</td><td>{row.series}</td><td className="whitespace-nowrap">{row.numberFrom}–{row.numberTo}</td><td className="font-mono text-xs">{row.protocol ?? '—'}</td>
          <td><Badge tone={row.status === 'REGISTERED' ? 'green' : 'red'}>{row.status === 'REGISTERED' ? 'Registrada' : 'Rejeitada'}</Badge></td><td className="max-w-72 text-xs">{row.justification}{row.message && <span className="block text-red-700">{row.message}</span>}</td></tr>)}
      </DataTable>}</div>

    <h2 className="mb-3 text-lg font-semibold text-slate-900">Histórico de contingências</h2>
    {data && data.history.length === 0 ? <EmptyState icon="🗓️" title="Sem registros" hint="Nenhuma contingência foi registrada." /> :
      <DataTable columns={[{ label: 'Início' }, { label: 'Fim' }, { label: 'Motivo' }]} footer={`${data?.history.length ?? 0} registro(s)`}>
        {data?.history.map(row => <tr key={row.id}><td>{formatDateTime(row.startedAt)}</td><td>{row.endedAt ? formatDateTime(row.endedAt) : <Badge tone="amber">Em andamento</Badge>}</td><td>{row.reason}</td></tr>)}
      </DataTable>}
  </AppShell>;
}
