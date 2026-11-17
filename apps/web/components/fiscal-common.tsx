'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, downloadFile, errorMessage, saveText } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';
import { environmentLabel, fiscalStatusLabel, fiscalStatusTone, type FiscalSettingsView } from '../lib/types-fiscal';
import { Field, secondaryButtonClass } from './app-shell';
import { Badge } from './ui';

// Shared pieces of the fiscal screens (Documentos fiscais, Contingências, XMLs).

export function useFiscalSettings() {
  const [settings, setSettings] = useState<FiscalSettingsView | null>(null);
  const [error, setError] = useState('');
  async function load() {
    try { setSettings(await api<FiscalSettingsView>('/fiscal/settings')); setError(''); } catch (e) { setError(errorMessage(e, 'Não foi possível carregar a configuração fiscal.')); }
  }
  useAutoLoad(load);
  return { settings, error, reload: load };
}

export function EnvironmentBanner({ settings, error }: { settings: FiscalSettingsView | null; error?: string }) {
  if (!settings) return error ? <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 print:hidden">Ambiente fiscal desconhecido: {error}</div> : null;
  const homologation = settings.environment === 'HOMOLOGATION';
  return <div role="status" className={`mb-4 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-sm print:hidden ${homologation ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
    <span className="font-semibold">Ambiente fiscal:</span>
    <Badge tone={homologation ? 'amber' : 'green'}>{environmentLabel[settings.environment]}</Badge>
    <span>{homologation ? 'documentos sem valor fiscal' : 'documentos com valor fiscal'}</span>
    <span className="ml-auto text-xs opacity-80">{settings.provider ? `Provedor: ${settings.provider}` : 'Nenhum provedor fiscal configurado'}</span>
  </div>;
}

export function FiscalStatusBadges({ status, contingency }: { status: string; contingency?: boolean }) {
  return <span className="inline-flex flex-wrap gap-1">
    <Badge tone={fiscalStatusTone[status] ?? 'neutral'}>{fiscalStatusLabel[status] ?? status}</Badge>
    {contingency && status !== 'CONTINGENCY' && <Badge tone="gold">Contingência</Badge>}
    {contingency && status === 'AUTHORIZED' && <Badge tone="green">Regularizado</Badge>}
  </span>;
}

export const modelLabel: Record<string, string> = { NFCE: 'NFC-e', NFE: 'NF-e' };

// ---------- Períodos (horário local, enviados em ISO) ----------
export type PeriodKey = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'custom';
export type Period = { key: PeriodKey; from: string; to: string };
export const periodOptions: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Hoje' }, { key: 'yesterday', label: 'Ontem' }, { key: 'week', label: 'Esta semana' }, { key: 'lastWeek', label: 'Semana anterior' },
  { key: 'month', label: 'Este mês' }, { key: 'lastMonth', label: 'Mês anterior' }, { key: 'custom', label: 'Personalizado' },
];
const ymd = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
export function makePeriod(key: PeriodKey, now = new Date()): Period {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const range = (from: Date, to: Date): Period => ({ key, from: ymd(from), to: ymd(to) });
  switch (key) {
    case 'yesterday': return range(addDays(today, -1), addDays(today, -1));
    case 'week': return range(monday, today);
    case 'lastWeek': return range(addDays(monday, -7), addDays(monday, -1));
    case 'month': return range(new Date(today.getFullYear(), today.getMonth(), 1), today);
    case 'lastMonth': return range(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0));
    default: return range(today, today);
  }
}
export const dayStartIso = (date: string) => new Date(`${date}T00:00:00`).toISOString();
export const dayEndIso = (date: string) => new Date(`${date}T23:59:59.999`).toISOString();
export function setPeriodParams(params: URLSearchParams, period: Period) {
  if (period.from) params.set('from', dayStartIso(period.from));
  if (period.to) params.set('to', dayEndIso(period.to));
  return params;
}

export function PeriodFilter({ value, onChange }: { value: Period; onChange: (period: Period) => void }) {
  return <div className="flex flex-wrap items-end gap-2">
    <div role="group" aria-label="Período" className="flex flex-wrap gap-1">
      {periodOptions.map(option => <button key={option.key} type="button" aria-pressed={value.key === option.key} onClick={() => onChange(option.key === 'custom' ? { ...value, key: 'custom' } : makePeriod(option.key))}
        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${value.key === option.key ? 'border-neutral-950 bg-neutral-950 text-brand-300' : 'border-slate-300 bg-white text-slate-600 hover:border-brand-400 hover:text-brand-700'}`}>{option.label}</button>)}
    </div>
    {value.key === 'custom' && <>
      <div className="w-40"><Field label="De" type="date" value={value.from} max={value.to || undefined} onChange={e => onChange({ ...value, from: e.target.value })} /></div>
      <div className="w-40"><Field label="Até" type="date" value={value.to} min={value.from || undefined} onChange={e => onChange({ ...value, to: e.target.value })} /></div>
    </>}
  </div>;
}

// ---------- Modal / XML ----------
export function Modal({ title, onClose, children, wide, id }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; id?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div id={id} className={`my-6 w-full ${wide ? 'max-w-5xl' : 'max-w-2xl'} rounded-2xl bg-white p-5 text-slate-900 shadow-xl`}>
      <div className="mb-3 flex items-center justify-between gap-3 print:hidden"><h3 className="text-lg font-semibold">{title}</h3><button type="button" className={secondaryButtonClass} onClick={onClose}>Fechar</button></div>
      {children}
    </div>
  </div>;
}

export type XmlFile = { fileName: string; xml: string };
export function XmlModal({ file, onClose }: { file: XmlFile; onClose: () => void }) {
  return <Modal title={`XML — ${file.fileName}`} onClose={onClose} wide>
    <p className="mb-2 text-xs text-slate-500">Arquivo original armazenado (sem alterações).</p>
    <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">{file.xml}</pre>
    <div className="mt-3 flex justify-end"><button type="button" className={secondaryButtonClass} onClick={() => saveText(file.xml, file.fileName)}>Baixar XML</button></div>
  </Modal>;
}

// ZIP export of the stored XMLs; returns the human-readable count reported by the server.
export async function exportXmlZip(params: URLSearchParams) {
  try {
    const headers = await downloadFile(`/fiscal/xml/export?${params}`, 'xml.zip');
    return `${headers.get('X-Document-Count') ?? '0'} documento(s) e ${headers.get('X-Event-Count') ?? '0'} evento(s) exportados.`;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error('Nenhum XML encontrado com os filtros informados.');
    throw e;
  }
}

// ---------- Resultado de operações em lote ----------
export type BatchResponse = { processed: number; results: { id: string; status?: string; error?: string; message?: string | null }[] };
export function BatchResults({ title, data, describe, onClose }: { title: string; data: BatchResponse; describe: (id: string) => string; onClose: () => void }) {
  return <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="mb-2 flex items-center justify-between gap-3"><h3 className="font-semibold text-slate-900">{title}: {data.processed} documento(s) processado(s)</h3><button type="button" className={secondaryButtonClass} onClick={onClose}>Fechar</button></div>
    {data.results.length === 0 ? <p className="text-sm text-slate-500">Nenhum documento elegível.</p> : <ul className="divide-y divide-slate-100 text-sm">
      {data.results.map(result => <li key={result.id} className="flex flex-wrap items-center gap-2 py-1.5"><span className="font-medium text-slate-800">{describe(result.id)}</span>
        {result.status ? <FiscalStatusBadges status={result.status} /> : <Badge tone="red">Falha</Badge>}
        {(result.error || result.message) && <span className="text-slate-600">{result.error ?? result.message}</span>}</li>)}
    </ul>}
  </section>;
}
