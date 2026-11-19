'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime } from '../../lib/api';
import { buttonClass, Field, Notice, panelClass, Select, secondaryButtonClass } from '../app-shell';
import { Badge, Toggle } from '../ui';
import { KIND_LABEL, SEVERITY_TONE, type AiAsk, type AiDomainKey, type AiToolResult } from '../../lib/types-ai';

export const monthAgo = () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

export function PeriodBar({ from, to, setFrom, setTo, unit, setUnit, units }: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void; unit: string; setUnit: (value: string) => void; units: { id: string; name: string }[] | null }) {
  return <div className="mb-4 flex flex-wrap items-end gap-3">
    <Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} /><Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} />
    {units && <Select label="Unidade" value={unit} onChange={event => setUnit(event.target.value)}><option value="">Todas as unidades autorizadas</option>{units.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
  </div>;
}
export const periodQuery = (from: string, to: string, unit: string) => new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString(), ...(unit ? { unitId: unit } : {}) }).toString();

// Period, unit, source and kind of every result, plus alerts, limitations and where the answer came from (computed now / cache).
export function Insight({ result, reuse }: { result: AiToolResult; reuse?: string }) {
  return <div className="mb-4 space-y-3">
    {result.alerts.length > 0 && <div className="space-y-2">{result.alerts.map((alert, index) => <div key={index} role="note" className={`rounded-xl border px-4 py-2 text-sm ${alert.severity === 'critical' ? 'border-red-300 bg-red-50 text-red-800' : alert.severity === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}><Badge tone={SEVERITY_TONE[alert.severity]}>{alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Info'}</Badge> {alert.message}</div>)}</div>}
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{result.highlights.map(line => <li key={line}>{line}</li>)}</ul>
    <p className="text-xs text-slate-500">
      <Badge tone={result.kind === 'FACT' ? 'green' : 'amber'}>{KIND_LABEL[result.kind]}</Badge> Período: {formatDateTime(result.period.from)} a {formatDateTime(result.period.to)} · Unidade: {result.unit ?? '—'} · Fonte: {result.source}{reuse ? ` · ${reuse === 'cache' ? 'resultado reaproveitado (dados inalterados)' : reuse === 'deduplicated' ? 'cálculo compartilhado com requisição simultânea' : 'calculado agora'}` : ''}
    </p>
    {result.limitations.length > 0 && <details className="text-xs text-slate-600"><summary className="cursor-pointer font-medium">Limitações e premissas</summary><ul className="mt-1 list-disc pl-5">{result.limitations.map(line => <li key={line}>{line}</li>)}</ul></details>}
  </div>;
}

export function AskBox({ domain, from, to, unit, placeholder }: { domain?: AiDomainKey; from: string; to: string; unit: string; placeholder: string }) {
  const [question, setQuestion] = useState(''); const [useAi, setUseAi] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [estimate, setEstimate] = useState<string>('');
  const [answer, setAnswer] = useState<AiAsk | null>(null); const [conversationId, setConversationId] = useState<string | undefined>();
  // Nothing is sent or recorded: only a character-based estimate and whether a model call would be allowed now.
  async function estimateCall() {
    if (question.trim().length < 3) return; setError('');
    try {
      const r = await api<{ domains: { name: string }[]; estimate: { inputTokens: number; inputTokensMax: number; maxOutputTokens: number }; modelCallAllowed: boolean; reason: string | null }>('/ai/estimate', { method: 'POST', body: JSON.stringify({ question }) });
      setEstimate(`Estimativa (não é consumo real): ${r.estimate.inputTokens}–${r.estimate.inputTokensMax} tokens de entrada e até ${r.estimate.maxOutputTokens} de saída. ${r.modelCallAllowed ? 'A chamada ao modelo seria permitida agora.' : `Sem chamada ao modelo: ${r.reason ?? 'indisponível'}`}`);
    } catch (cause) { setError(errorMessage(cause, 'Falha ao estimar')); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (question.trim().length < 3) return;
    setBusy(true); setError('');
    try {
      const response = await api<AiAsk>('/ai/ask', { method: 'POST', body: JSON.stringify({ question, useAi, conversationId, domain, from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString(), ...(unit ? { unitId: unit } : {}) }) });
      setAnswer(response); setConversationId(response.conversationId);
    } catch (cause) { setError(errorMessage(cause, 'Falha ao consultar')); } finally { setBusy(false); }
  }
  return <section className={`${panelClass} mb-6`}>
    <form onSubmit={submit} className="space-y-3">
      <Field label={domain ? 'Pergunte a este especialista' : 'Pergunte à SUPER IA RM Intelligence'} placeholder={placeholder} maxLength={300} value={question} onChange={event => setQuestion(event.target.value)} />
      <div className="flex flex-wrap items-center gap-4"><button className={buttonClass} disabled={busy}>{busy ? 'Consultando…' : 'Perguntar'}</button>
        <button type="button" className={secondaryButtonClass} onClick={() => void estimateCall()}>Estimar consumo</button>
        <Toggle label="Pedir explicação por IA externa" hint="Só envia números agregados e exige o consentimento da empresa." checked={useAi} onChange={setUseAi} /></div>
    </form>
    {estimate && <p className="mt-2 text-xs text-slate-600">{estimate}</p>}
    {error && <div className="mt-3"><Notice message={error} /></div>}
    {answer && <div className="mt-4 space-y-3 text-sm">
      {answer.needsClarification && <Notice message={answer.answer} />}
      {answer.denied.map(item => <Notice key={item.key} message={item.reason} />)}
      {answer.results.length > 0 && <pre className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 font-sans text-slate-800">{answer.answer}</pre>}
      {answer.ai && <div className="rounded-xl border border-brand-500/40 p-3"><p className="whitespace-pre-wrap text-slate-800">{answer.ai.text}</p><p className="mt-1 text-xs text-slate-500">{answer.ai.note}{answer.ai.model ? ` Modelo: ${answer.ai.model}.` : ''}</p></div>}
      {answer.aiNote && <p className="text-xs text-slate-500">{answer.aiNote}</p>}
      {answer.domains.length > 0 && <p className="text-xs text-slate-500">Especialistas consultados: {answer.domains.map(item => item.name).join('; ')}.</p>}
      {answer.results.map(result => <p key={result.tool} className="text-xs text-slate-500">{result.title}: {KIND_LABEL[result.kind]} · {result.unit} · {result.source}</p>)}
    </div>}
  </section>;
}
