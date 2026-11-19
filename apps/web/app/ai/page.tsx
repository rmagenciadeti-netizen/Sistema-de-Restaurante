'use client';

import { useEffect, useState } from 'react';
import Link from '../../components/nav-link';
import { api, errorMessage, formatDateTime, ListResponse, storedUser, Unit } from '../../lib/api';
import { AppShell, buttonClass, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, EmptyState, PageHeader, PanelSkeleton, Tabs } from '../../components/ui';
import { AskBox, monthAgo, PeriodBar, periodQuery, today } from '../../components/ai/ai-common';

import { SEVERITY_TONE, type AiAsk, type AiDomainList } from '../../lib/types-ai';
import dynamic from 'next/dynamic';
const UsagePanel = dynamic(() => import('../../components/ai/usage-panel').then(module => module.UsagePanel), { loading: () => <PanelSkeleton lines={5} /> });

const tabs = [{ key: 'overview', label: '🧭 Visão geral' }, { key: 'assistant', label: '🧠 Assistente central' }, { key: 'diagnosis', label: '🩺 Diagnóstico integrado' }, { key: 'usage', label: '📊 Consumo e controles' }] as const;
type Tab = (typeof tabs)[number]['key'];
const MANAGEMENT = ['ADMIN', 'MANAGER'];

export default function IntelligenceCenterPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [list, setList] = useState<AiDomainList | null>(null); const [error, setError] = useState('');
  const [from, setFrom] = useState(monthAgo); const [to, setTo] = useState(today); const [unit, setUnit] = useState(''); const [units, setUnits] = useState<Unit[] | null>(null);
  const [diagnosis, setDiagnosis] = useState<AiAsk | null>(null); const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  // Read after mount: the stored profile does not exist on the server, so reading it while rendering would mismatch the HTML.
  const [canSeeUsage, setCanSeeUsage] = useState(false);
  useEffect(() => { setCanSeeUsage(MANAGEMENT.includes(storedUser().role ?? '')); }, []);
  useEffect(() => {
    api<AiDomainList>('/ai/domains').then(async result => { setList(result); if (result.canSelectUnit) setUnits((await api<ListResponse<Unit>>('/units')).items); }).catch(cause => setError(errorMessage(cause, 'Falha ao carregar a central')));
  }, []);
  useEffect(() => { if (tab === 'assistant') api<{ items: { id: string; title: string; updatedAt: string }[] }>('/ai/conversations').then(result => setHistory(result.items)).catch(() => setHistory([])); }, [tab]);
  async function diagnose() {
    setBusy(true); setError('');
    try { setDiagnosis(await api<AiAsk>('/ai/ask', { method: 'POST', body: JSON.stringify({ question: 'Faça um diagnóstico geral da operação', from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString(), ...(unit ? { unitId: unit } : {}) }) })); }
    catch (cause) { setError(errorMessage(cause, 'Falha ao gerar o diagnóstico')); } finally { setBusy(false); }
  }
  const available = list?.available ?? [];
  const visibleTabs = tabs.filter(item => (item.key !== 'usage' || canSeeUsage) && (item.key !== 'diagnosis' || available.some(domain => domain.key === 'management')));
  return <AppShell title="RM Intelligence">
    <PageHeader title="RM INTELLIGENCE — Central de Inteligência Empresarial" subtitle="A SUPER IA coordena especialistas independentes, consulta só os necessários e respeita a sua permissão e a licença contratada. Os números vêm do sistema; a IA externa só explica." />
    {error && <Notice message={error} />}
    <Tabs tabs={[...visibleTabs]} value={tab} onChange={setTab} label="Seções da central" />
    {tab === 'overview' && (!list ? <p className="text-sm text-slate-500">Carregando…</p> : <>
      {available.length === 0 && <EmptyState icon="🔒" title="Nenhum especialista disponível para o seu perfil" hint="Solicite autorização ao administrador responsável." />}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{available.map(domain => <Link key={domain.key} href={`/ai/${domain.key}`} className={`${panelClass} block transition hover:-translate-y-0.5`}><p className="text-2xl">{domain.icon}</p><h3 className="mt-1 font-semibold">{domain.name}</h3><p className="mt-1 text-sm text-slate-600">{domain.description}</p><p className="mt-2 text-xs text-brand-700">Abrir painel →</p></Link>)}</div>
      {list.unavailable.length > 0 && <div className="mt-6 space-y-2">{list.unavailable.map(item => <Notice key={item.key} message={item.reason} />)}</div>}
      <p className="mt-6 text-xs text-slate-500">IA externa: {list.external.providerConfigured ? (list.external.consent && list.external.enabled ? 'ativa (com consentimento da empresa)' : 'configurada, aguardando consentimento/habilitação da empresa') : 'não configurada neste ambiente'}. As análises determinísticas funcionam em qualquer caso.</p>
    </>)}
    {tab === 'assistant' && <>
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} unit={unit} setUnit={setUnit} units={units} />
      <AskBox from={from} to={to} unit={unit} placeholder="Ex.: Qual o faturamento por canal? Quais insumos estão em risco?" />
      <section className={panelClass}><h3 className="mb-2 font-semibold">Seu histórico</h3>{history.length === 0 ? <p className="text-sm text-slate-500">Nenhuma conversa ainda.</p> : <ul className="space-y-1 text-sm">{history.map(item => <li key={item.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1"><span className="truncate">{item.title}</span><span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">{formatDateTime(item.updatedAt)}<button className={secondaryButtonClass} onClick={async () => { await api(`/ai/conversations/${item.id}`, { method: 'DELETE' }); setHistory(history.filter(row => row.id !== item.id)); }}>Excluir</button></span></li>)}</ul>}<p className="mt-2 text-xs text-slate-500">O histórico é privado (por empresa e usuário) e removido automaticamente após o período de retenção.</p></section>
    </>}
    {tab === 'diagnosis' && <>
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} unit={unit} setUnit={setUnit} units={units} />
      <button className={`${buttonClass} mb-4`} disabled={busy} onClick={() => void diagnose()}>{busy ? 'Consultando especialistas…' : 'Gerar diagnóstico integrado'}</button>
      {diagnosis && <div className="space-y-4">
        <section className={panelClass}><h3 className="mb-2 font-semibold">Alertas e recomendações prioritários</h3>{diagnosis.alerts.length === 0 ? <p className="text-sm text-slate-600">Nenhum alerta nos dados do período.</p> : <ul className="space-y-2 text-sm">{diagnosis.alerts.map((alert, index) => <li key={index}><Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Info'}</Badge> {alert.message} <Link className="text-xs text-brand-700 underline" href={`/ai/${alert.domain.split('.')[0]}`}>ver especialista</Link></li>)}</ul>}</section>
        {diagnosis.results.map(result => <section key={result.tool} className={panelClass}><h3 className="font-semibold"><Link className="hover:underline" href={`/ai/${result.tool.split('.')[0]}`}>{result.title}</Link></h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{result.highlights.map(line => <li key={line}>{line}</li>)}</ul><p className="mt-2 text-xs text-slate-500">Unidade: {result.unit} · {result.source}</p></section>)}
        {diagnosis.denied.length > 0 && <p className="text-xs text-slate-500">Sem acesso/indisponível: {diagnosis.denied.map(item => item.name).join('; ')}.</p>}
      </div>}
    </>}
    {tab === 'usage' && canSeeUsage && <UsagePanel />}
  </AppShell>;
}
