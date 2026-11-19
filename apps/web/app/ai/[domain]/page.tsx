'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from '../../../components/nav-link';
import { api, downloadFile, errorMessage, ListResponse, Unit } from '../../../lib/api';
import { AppShell, Notice, secondaryButtonClass } from '../../../components/app-shell';
import { PageHeader } from '../../../components/ui';
import { AskBox, Insight, monthAgo, PeriodBar, periodQuery, today } from '../../../components/ai/ai-common';

import type { AiDomainKey, AiDomainList, AiPanel } from '../../../lib/types-ai';
import dynamic from 'next/dynamic';
import { PanelSkeleton } from '../../../components/ui';
const SpecialistView = dynamic(() => import('../../../components/ai/specialist-views').then(module => module.SpecialistView), { loading: () => <PanelSkeleton lines={5} /> });

const PLACEHOLDERS: Record<AiDomainKey, string> = {
  finance: 'Ex.: Quais contas vencem esta semana?', stock: 'Ex.: Quais insumos estão em risco de ruptura?', profit: 'Ex.: Qual a margem e o CMV do período?', sales: 'Ex.: Qual o faturamento por canal?', purchasing: 'Ex.: O que devo comprar?',
  customers: 'Ex.: Quantos clientes estão inativos?', delivery: 'Ex.: Qual o tempo médio de entrega?', production: 'Ex.: Há pedidos atrasados na cozinha?', waste: 'Ex.: Onde estamos perdendo mais?', management: 'Ex.: Faça um diagnóstico geral da operação',
};

export default function SpecialistPage() {
  const key = useParams<{ domain: string }>().domain as AiDomainKey;
  const [from, setFrom] = useState(monthAgo); const [to, setTo] = useState(today); const [unit, setUnit] = useState('');
  const [units, setUnits] = useState<Unit[] | null>(null); const [panel, setPanel] = useState<AiPanel | null>(null); const [error, setError] = useState(''); const [blocked, setBlocked] = useState(''); const [ready, setReady] = useState(false);
  useEffect(() => {
    // The server decides what this profile may open; nothing is requested for a specialist that is not on the list.
    api<AiDomainList>('/ai/domains').then(async list => {
      if (!list.available.some(item => item.key === key)) { setBlocked(list.unavailable.find(item => item.key === key)?.reason ?? 'Você não tem acesso a este especialista. Solicite autorização ao administrador responsável.'); return; }
      if (list.canSelectUnit) setUnits((await api<ListResponse<Unit>>('/units')).items);
      setReady(true);
    }).catch(cause => setError(errorMessage(cause, 'Falha ao carregar o especialista')));
  }, [key]);
  const load = useCallback(async () => {
    if (blocked || !ready) return;
    try { setError(''); setPanel(await api<AiPanel>(`/ai/domains/${key}/panel?${periodQuery(from, to, unit)}`)); } catch (cause) { setPanel(null); setError(errorMessage(cause, 'Falha ao carregar o painel')); }
  }, [key, from, to, unit, blocked, ready]);
  useEffect(() => { void load(); }, [load]);
  return <AppShell title="RM Intelligence">
    <PageHeader title={panel?.domain.name ?? 'RM Intelligence'} subtitle={panel?.domain.description} backHref="/ai" />
    {blocked && <Notice message={blocked} />}
    {error && <Notice message={error} />}
    {!blocked && <>
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} unit={unit} setUnit={setUnit} units={units} />
      <div className="mb-4 flex justify-end"><button type="button" className={secondaryButtonClass} onClick={() => void downloadFile(`/ai/domains/${key}/export.csv?${periodQuery(from, to, unit)}`, `rm-${key}.csv`).catch(cause => setError(errorMessage(cause, 'Falha ao exportar')))}>Exportar CSV</button></div>
      {!panel && !error && <p className="text-sm text-slate-500">Carregando…</p>}
      {panel && <>
        <AskBox domain={key} from={from} to={to} unit={unit} placeholder={PLACEHOLDERS[key] ?? 'Pergunte algo'} />
        {panel.results.map(result => <section key={result.tool}><Insight result={result} reuse={panel.reuse[result.tool]} /><SpecialistView result={result} /></section>)}
        {key === 'profit' && <p className="mt-6 text-sm text-slate-600">Para simular preços, aplicar margens e ver o painel de formação de preço use <Link className="font-semibold text-brand-700 underline" href="/pricing">Formação de preço e rentabilidade</Link> e <Link className="font-semibold text-brand-700 underline" href="/profit">RM Controle de Lucro</Link>: esta análise reaproveita o mesmo motor.</p>}
      </>}
    </>}
  </AppShell>;
}
