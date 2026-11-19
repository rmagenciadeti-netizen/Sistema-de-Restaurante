'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE, api, errorMessage, tokenStorageKey } from '../../lib/api';
import { Field, Notice, secondaryButtonClass, Select } from '../app-shell';
import { ReportTableView } from '../report-table';
import type { ReportTable } from '../../lib/types-reports';
import { Section } from './common';

type Item = { kind: string; title: string; description: string };
const day = (date: Date) => date.toISOString().slice(0, 10);
const daysAgo = (count: number) => new Date(Date.now() - count * 86_400_000);

export function CommercialReports() {
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState('subscriptions-by-plan');
  const [from, setFrom] = useState(day(daysAgo(90)));
  const [to, setTo] = useState(day(new Date()));
  const [table, setTable] = useState<ReportTable | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = `from=${from}T00:00:00-03:00&to=${to}T23:59:59-03:00`;

  useEffect(() => { api<{ items: Item[] }>('/commercial/reports').then(result => setItems(result.items)).catch(cause => setError(errorMessage(cause, 'Falha ao carregar a lista de relatórios'))); }, []);
  const load = useCallback(async () => {
    setError('');
    try { setTable(await api<ReportTable>(`/commercial/reports/${kind}?${query}`)); } catch (cause) { setTable(null); setError(errorMessage(cause, 'Falha ao gerar o relatório')); }
  }, [kind, query]);
  useEffect(() => { void load(); }, [load]);

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    setBusy(true); setError('');
    try {
      const token = localStorage.getItem(tokenStorageKey);
      const response = await fetch(`${API_BASE}/commercial/reports/${kind}?${query}&format=${format}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível exportar o relatório');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob()); link.download = `comercial-${kind}-${from}_${to}.${format}`; link.click();
      URL.revokeObjectURL(link.href);
    } catch (cause) { setError(errorMessage(cause, 'Erro ao exportar')); } finally { setBusy(false); }
  }

  const current = items.find(item => item.kind === kind);
  return <Section title="Relatórios comerciais" actions={<div className="flex gap-2">{(['csv', 'xlsx', 'pdf'] as const).map(format => <button key={format} type="button" className={secondaryButtonClass} disabled={busy || !table} onClick={() => void download(format)}>{format === 'csv' ? '⬇ CSV' : format === 'xlsx' ? '⬇ Excel' : '⬇ PDF'}</button>)}</div>}>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-64"><Select label="Relatório" value={kind} onChange={event => setKind(event.target.value)}>{items.map(item => <option key={item.kind} value={item.kind}>{item.title}</option>)}</Select></div>
      <Field label="De" type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} />
      <Field label="Até" type="date" value={to} min={from} onChange={event => setTo(event.target.value)} />
    </div>
    {current && <p className="mb-3 text-xs text-slate-600">{current.description} Períodos filtram pela data do evento (pagamento, criação ou alteração); situações atuais ignoram o período.</p>}
    {error && <Notice message={error} />}
    {table && <ReportTableView table={table} />}
  </Section>;
}
