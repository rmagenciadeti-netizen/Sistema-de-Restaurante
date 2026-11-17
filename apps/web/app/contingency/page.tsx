'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';
import type { ContingencyResponse } from '../../lib/types-fiscal';

const kindLabel: Record<string, string> = { NFCE: 'NFC-e', NFE: 'NF-e' };
const statusLabel: Record<string, string> = { PENDING: 'Pendente', REJECTED: 'Rejeitado' };

export default function ContingencyPage() {
  const [data, setData] = useState<ContingencyResponse | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() { try { setData(await api<ContingencyResponse>('/fiscal-registry/contingency')); } catch (e) { fail(e, 'Erro ao carregar contingências'); } }
  useAutoLoad(load);

  async function run(path: 'start' | 'end', body?: unknown, success?: string) {
    setNotice(null); setBusy(true);
    try { await api(`/fiscal-registry/contingency/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); setReason(''); setNotice({ text: success ?? 'Atualizado.', kind: 'success' }); await load(); } catch (e) { fail(e, 'Erro ao atualizar contingência'); } finally { setBusy(false); }
  }

  return <AppShell title="Contingências">
    <PageHeader title="Contingências" subtitle="Registre os períodos em que a empresa operou sem conexão com o provedor fiscal e acompanhe os documentos que ficaram pendentes. O registro é informativo: não liga o modo offline do provedor nem retransmite documentos." />
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
    <h2 className="mb-3 text-lg font-semibold text-slate-900">Documentos pendentes de transmissão ({data?.pending.length ?? 0})</h2>
    {data && data.pending.length === 0 ? <div className="mb-6"><EmptyState icon="✅" title="Nenhum documento pendente" hint="Pedidos com emissão pendente ou rejeitada aparecem aqui para nova tentativa em Documentos fiscais." /></div> :
      <div className="mb-6"><DataTable columns={[{ label: 'Pedido' }, { label: 'Tipo' }, { label: 'Situação' }, { label: 'Motivo' }, { label: 'Data' }]} footer={<Link className={secondaryButtonClass} href="/fiscal">Ir para Documentos fiscais</Link>}>
        {data?.pending.map(row => <tr key={row.id}><td className="font-medium text-slate-900">{row.order ? `${row.order.code} — ${formatMoney(row.order.total)}` : '—'}</td><td>{kindLabel[row.kind] ?? row.kind}</td><td><Badge tone={row.status === 'REJECTED' ? 'red' : 'amber'}>{statusLabel[row.status] ?? row.status}</Badge></td><td>{row.error || '—'}</td><td>{formatDateTime(row.createdAt)}</td></tr>)}
      </DataTable></div>}
    <h2 className="mb-3 text-lg font-semibold text-slate-900">Histórico</h2>
    {data && data.history.length === 0 ? <EmptyState icon="🗓️" title="Sem registros" hint="Nenhuma contingência foi registrada." /> :
      <DataTable columns={[{ label: 'Início' }, { label: 'Fim' }, { label: 'Motivo' }]} footer={`${data?.history.length ?? 0} registro(s)`}>
        {data?.history.map(row => <tr key={row.id}><td>{formatDateTime(row.startedAt)}</td><td>{row.endedAt ? formatDateTime(row.endedAt) : <Badge tone="amber">Em andamento</Badge>}</td><td>{row.reason}</td></tr>)}
      </DataTable>}
  </AppShell>;
}
