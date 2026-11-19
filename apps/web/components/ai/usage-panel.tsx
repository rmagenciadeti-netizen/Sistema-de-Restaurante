'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, storedUser } from '../../lib/api';
import { buttonClass, Field, Notice, panelClass } from '../app-shell';
import { DataTable, EmptyState, StatCard, Toggle } from '../ui';
import type { AiComparison, AiUsage } from '../../lib/types-ai';

export function UsagePanel() {
  const [data, setData] = useState<AiUsage | null>(null); const [error, setError] = useState(''); const [ok, setOk] = useState('');
  const [limits, setLimits] = useState({ llmCallsPerTenantDay: '100', llmCallsPerUserDay: '30', llmCallsPerModuleDay: '50', llmCallsPerUnitDay: '60' });
  const [compare, setCompare] = useState<AiComparison | null>(null);
  const isAdmin = storedUser().role === 'ADMIN';
  const load = useCallback(async () => {
    try { const usage = await api<AiUsage>('/ai/usage?days=30'); setData(usage); setLimits({ llmCallsPerTenantDay: String(usage.settings.limits.llmCallsPerTenantDay), llmCallsPerUserDay: String(usage.settings.limits.llmCallsPerUserDay), llmCallsPerModuleDay: String(usage.settings.limits.llmCallsPerModuleDay), llmCallsPerUnitDay: String(usage.settings.limits.llmCallsPerUnitDay ?? 60) }); setCompare(await api<AiComparison>('/ai/usage/compare?days=7')); }
    catch (cause) { setError(errorMessage(cause, 'Falha ao carregar o consumo')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(patch: Record<string, unknown>) {
    setError(''); setOk('');
    try { await api('/ai/settings', { method: 'PUT', body: JSON.stringify(patch) }); setOk('Configuração salva.'); await load(); } catch (cause) { setError(errorMessage(cause, 'Falha ao salvar')); }
  }
  if (!data) return <>{error ? <Notice message={error} /> : <p className="text-sm text-slate-500">Carregando…</p>}</>;
  const t = data.totals;
  return <div className="space-y-5">
    {error && <Notice message={error} />}{ok && <Notice message={ok} kind="success" />}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <StatCard icon="🧠" label="Chamadas ao modelo (30 dias)" value={t.modelCalls} hint={data.tokens ? `${data.tokens.real.tokens} tokens reais (informados pelo provedor) · ${data.tokens.estimated.tokens} estimados` : `${t.inputTokens} tokens de entrada · ${t.outputTokens} de saída`} tone="dark" />
      <StatCard icon="📊" label="Análises determinísticas" value={t.analyses} hint="Sem uso de modelo" />
      <StatCard icon="♻️" label="Reaproveitamento (cache + deduplicação)" value={t.reuseRatePercent === null ? '—' : `${t.reuseRatePercent}%`} hint={`${t.cacheHits} cache · ${t.deduplicated} simultâneas`} />
      <StatCard icon="🚦" label="Bloqueios e falhas" value={t.blockedByLimit + t.errors} hint={`${t.blockedByLimit} por limite · ${t.errors} erros · ${t.denied} negados`} />
    </div>
    <section className={panelClass}>
      <h3 className="mb-2 font-semibold">Limites diários (usados hoje / limite)</h3>
      <p className="text-sm text-slate-700">Estabelecimento {data.limits.tenant.used}/{data.limits.tenant.limit} ·{data.limits.unit ? ` Unidade ${data.limits.unit.used}/${data.limits.unit.limit} ·` : ''} Você {data.limits.user.used}/{data.limits.user.limit}. Provedor: {data.provider.configured ? `${data.provider.name} (${data.provider.model ?? 'modelo padrão'}${data.provider.simpleModel ? `; econômico: ${data.provider.simpleModel}` : ''})` : 'não configurado — somente análises determinísticas'}.</p>
      {isAdmin && <div className="mt-4 space-y-3">
        <Toggle label="Autorizo o envio de dados agregados e sem dados pessoais a um provedor externo de IA" hint="Opt-in da empresa (LGPD). Sem isso o modelo nunca é chamado." checked={data.settings.externalConsent} onChange={value => void save({ externalConsent: value })} />
        <Toggle label="IA externa habilitada" hint="Desligue para manter só as análises determinísticas." checked={data.settings.externalEnabled} onChange={value => void save({ externalEnabled: value })} />
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Chamadas/dia — unidade" type="number" min="0" value={limits.llmCallsPerUnitDay} onChange={event => setLimits({ ...limits, llmCallsPerUnitDay: event.target.value })} />
          <Field label="Chamadas/dia — estabelecimento" type="number" min="0" value={limits.llmCallsPerTenantDay} onChange={event => setLimits({ ...limits, llmCallsPerTenantDay: event.target.value })} />
          <Field label="Chamadas/dia — usuário" type="number" min="0" value={limits.llmCallsPerUserDay} onChange={event => setLimits({ ...limits, llmCallsPerUserDay: event.target.value })} />
          <Field label="Chamadas/dia — módulo" type="number" min="0" value={limits.llmCallsPerModuleDay} onChange={event => setLimits({ ...limits, llmCallsPerModuleDay: event.target.value })} />
          <div className="flex items-end"><button className={buttonClass} onClick={() => void save({ limits: { llmCallsPerTenantDay: Number(limits.llmCallsPerTenantDay), llmCallsPerUserDay: Number(limits.llmCallsPerUserDay), llmCallsPerModuleDay: Number(limits.llmCallsPerModuleDay), llmCallsPerUnitDay: Number(limits.llmCallsPerUnitDay) } })}>Salvar limites</button></div>
        </div>
      </div>}
    </section>
    {compare && <section className={panelClass}>
      <h3 className="mb-2 font-semibold">Antes e depois (últimos {compare.days} dias × {compare.days} dias anteriores)</h3>
      <DataTable columns={[{ label: 'Indicador' }, { label: 'Anterior', className: 'text-right' }, { label: 'Atual', className: 'text-right' }]}>
        {([['Chamadas ao modelo', 'modelCalls'], ['Reaproveitadas (cache)', 'cacheHits'], ['Deduplicadas', 'deduplicated'], ['Bloqueadas por limite', 'blockedByLimit'], ['Tokens reais', 'realTokens'], ['Tokens estimados', 'estimatedTokens']] as const).map(([label, key]) => <tr key={key}><td>{label}</td><td className="text-right">{compare.previous[key]}</td><td className="text-right">{compare.current[key]}</td></tr>)}</DataTable>
      <p className="mt-2 text-xs text-slate-500">{compare.note}</p></section>}
    <section><h3 className="mb-2 font-semibold">Operações de maior consumo</h3>{data.topOperations.length === 0 ? <EmptyState title="Sem uso registrado" /> : <DataTable columns={[{ label: 'Módulo' }, { label: 'Operação' }, { label: 'Tipo' }, { label: 'Execuções', className: 'text-right' }, { label: 'Tokens', className: 'text-right' }, { label: 'Latência média', className: 'text-right' }]}>
      {data.topOperations.map(row => <tr key={`${row.module}${row.operation}${row.kind}`}><td>{row.module}</td><td>{row.operation}</td><td>{row.kind === 'LLM' ? 'Modelo' : 'Determinística'}</td><td className="text-right">{row.count}</td><td className="text-right">{row.tokens}</td><td className="text-right">{row.avgLatencyMs} ms</td></tr>)}</DataTable>}</section>
    <section><h3 className="mb-2 font-semibold">Por módulo</h3><DataTable columns={[{ label: 'Módulo' }, { label: 'Tipo' }, { label: 'Eventos', className: 'text-right' }, { label: 'Tokens', className: 'text-right' }]}>{data.byModule.map(row => <tr key={`${row.module}${row.kind}`}><td>{row.module}</td><td>{row.kind}</td><td className="text-right">{row.count}</td><td className="text-right">{row.inputTokens + row.outputTokens}</td></tr>)}</DataTable></section>
    <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">{data.notes.map(note => <li key={note}>{note}</li>)}</ul>
  </div>;
}
