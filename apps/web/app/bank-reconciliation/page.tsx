'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney } from '../../lib/api';
import { AppShell, buttonClass, Notice, panelClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, StatCard } from '../../components/ui';

type Line = { date: string; amount: number; description: string };
type Entry = { id: string; type: 'INCOME' | 'EXPENSE'; amount: number; date: string; description: string };
type Result = { summary: { lines: number; matched: number; unmatchedLines: number; unmatchedEntries: number }; matches: { line: Line; entryId: string | null; entry: Entry | null }[]; unmatchedEntries: Entry[] };

export default function BankReconciliationPage() {
  const [result, setResult] = useState<Result | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true); setNotice(null); setResult(null);
    try {
      const content = await file.text();
      const format = /\.ofx$/i.test(file.name) || /<OFX>/i.test(content) ? 'OFX' : 'CSV';
      setResult(await api<Result>('/bank-reconciliation/match', { method: 'POST', body: JSON.stringify({ format, content }) }));
    } catch (cause) { setNotice({ text: errorMessage(cause, 'Falha ao ler o extrato'), kind: 'error' }); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!result) return;
    const ids = result.matches.flatMap(match => (match.entryId ? [match.entryId] : []));
    try {
      const done = await api<{ reconciled: number }>('/bank-reconciliation/confirm', { method: 'POST', body: JSON.stringify({ entryIds: ids }) });
      setNotice({ text: `${done.reconciled} lançamento(s) conciliado(s).`, kind: 'success' }); setResult(null);
    } catch (cause) { setNotice({ text: errorMessage(cause, 'Falha ao confirmar a conciliação'), kind: 'error' }); }
  }

  return <AppShell title="Conciliação bancária">
    <PageHeader title="Conciliação bancária" subtitle="Importe o extrato (OFX ou CSV com data, descrição e valor) e confronte com os lançamentos pagos. Confirmar apenas marca os lançamentos como conciliados; nada é criado ou alterado no financeiro." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <input type="file" accept=".ofx,.csv,.txt" disabled={busy} onChange={event => void upload(event.target.files?.[0])} aria-label="Arquivo do extrato" />
      <p className="mt-2 text-xs text-slate-500">Casamento por valor (entrada positiva, saída negativa) com tolerância de 3 dias entre a data do extrato e a do pagamento.</p>
    </section>
    {result && <>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatCard label="Linhas do extrato" value={result.summary.lines} /><StatCard label="Conciliadas" value={result.summary.matched} />
        <StatCard label="Extrato sem lançamento" value={result.summary.unmatchedLines} /><StatCard label="Lançamentos sem extrato" value={result.summary.unmatchedEntries} />
      </div>
      <DataTable columns={[{ label: 'Data' }, { label: 'Extrato' }, { label: 'Valor' }, { label: 'Lançamento' }, { label: 'Situação' }]}>
        {result.matches.map((match, index) => <tr key={index}><td>{match.line.date}</td><td>{match.line.description}</td><td>{formatMoney(match.line.amount)}</td><td>{match.entry?.description ?? '—'}</td><td><Badge tone={match.entry ? 'green' : 'red'}>{match.entry ? 'Conciliado' : 'Sem lançamento'}</Badge></td></tr>)}
      </DataTable>
      <div className="mt-3"><button type="button" className={buttonClass} disabled={result.summary.matched === 0} onClick={() => void confirm()}>Confirmar {result.summary.matched} conciliação(ões)</button></div>
      <h2 className="mb-2 mt-6 text-base font-bold">Pagos no período sem linha no extrato</h2>
      {result.unmatchedEntries.length === 0 ? <EmptyState title="Nenhum" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Descrição' }, { label: 'Tipo' }, { label: 'Valor' }]}>
        {result.unmatchedEntries.map(entry => <tr key={entry.id}><td>{entry.date}</td><td>{entry.description}</td><td>{entry.type === 'INCOME' ? 'Receita' : 'Despesa'}</td><td>{formatMoney(entry.amount)}</td></tr>)}
      </DataTable>}
    </>}
  </AppShell>;
}
