'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { outcomeLabels, outcomeTone, type MigrationEvent, type Report } from '../../lib/types-migration';
import { Select } from '../app-shell';
import { panelClass, secondaryButtonClass } from '../app-shell';
import { Badge, DataTable, EmptyState, StatCard } from '../ui';
import type { StepProps } from './files-step';

export function AuditStep({ base, session, notify }: StepProps) {
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<MigrationEvent[]>([]);
  const [eventPage, setEventPage] = useState({ page: 1, total: 0, type: '' });
  const EVENT_PAGE_SIZE = 50;
  const load = useCallback(async () => {
    try { setReport(await api<Report>(`${base}/report`)); }
    catch (error) { notify(errorMessage(error, 'Falha ao carregar a auditoria')); }
  }, [base, notify]);
  // The timeline is paginated (newest first): a long run writes one event per batch.
  const loadEvents = useCallback(async () => {
    try {
      const query = new URLSearchParams({ order: 'desc', page: String(eventPage.page), pageSize: String(EVENT_PAGE_SIZE), ...(eventPage.type ? { type: eventPage.type } : {}) });
      const result = await api<{ items: MigrationEvent[]; total: number }>(`${base}/events?${query}`); setEvents(result.items); setEventPage(current => current.total === result.total ? current : { ...current, total: result.total });
    } catch (error) { notify(errorMessage(error, 'Falha ao carregar a linha do tempo')); }
  }, [base, notify, eventPage.page, eventPage.type]);
  useEffect(() => { void load(); void loadEvents(); }, [load, loadEvents, session.status, session.outcome]);
  const download = (extension: 'pdf' | 'csv') => downloadFile(`${base}/report.${extension}`, `migracao-${session.id.slice(0, 8)}.${extension}`).catch(error => notify(errorMessage(error, 'Falha ao baixar')));

  if (!report) return <EmptyState icon="🛡️" title="Carregando auditoria…" />;
  const totals = report.result.totals;
  return <div className="space-y-4">
    <section className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-base font-semibold">5. Auditoria e relatório final</h3>
          <p className="mt-1 text-sm text-slate-600">{report.identification.restaurant} · origem: {report.identification.sourceSystem} · criada por: {report.identification.operator ?? '—'}{report.identification.approvedBy ? ` · aprovada por ${report.identification.approvedBy}` : ''}{report.identification.executedBy ? ` · executada por ${report.identification.executedBy}` : ''}</p></div>
        <div className="flex gap-2"><button type="button" className={secondaryButtonClass} onClick={() => void download('pdf')}>Exportar PDF</button><button type="button" className={secondaryButtonClass} onClick={() => void download('csv')}>Exportar CSV detalhado</button></div>
      </div>
      <p className="mt-3 text-sm">Situação geral: <Badge tone={outcomeTone(report.overall.outcome)}>{report.overall.outcome ? outcomeLabels[report.overall.outcome] : report.overall.outcomeLabel}</Badge> <span className="text-slate-500">({report.overall.statusLabel}{report.result.durationSeconds !== null ? ` · ${report.result.durationSeconds}s` : ''})</span></p>
    </section>
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Lidos" value={totals.read} /><StatCard label="Importados" value={totals.imported} /><StatCard label="Duplicados" value={totals.duplicates} />
      <StatCard label="Rejeitados" value={totals.rejected} /><StatCard label="Falhas" value={totals.failed} /><StatCard label="Pendentes" value={totals.pending} hint={`${totals.ignored} ignorados`} />
    </div>
    <DataTable columns={[{ label: 'Grupo de dados' }, { label: 'Origem' }, { label: 'Importados' }, { label: 'Duplicados' }, { label: 'Rejeitados' }, { label: 'Falhas' }, { label: 'Ignorados' }, { label: 'Pendentes' }]}>
      {report.groups.filter(group => group.read > 0).map(group => <tr key={group.key}><td className="font-medium">{group.label}</td><td>{group.read}</td><td>{group.imported}</td><td>{group.duplicates}</td><td>{group.rejected}</td><td>{group.failed}</td><td>{group.ignored}</td><td>{group.pending}</td></tr>)}
    </DataTable>
    {(report.financial.payable.count > 0 || report.financial.receivable.count > 0 || report.financial.initialBalances.accounts > 0) && <section className={panelClass}><h4 className="font-semibold">Resultado financeiro</h4>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="p-2"></th><th className="p-2">Lançamentos</th><th className="p-2">Valor original</th><th className="p-2">Baixado</th><th className="p-2">Em aberto</th><th className="p-2">Vencidos</th></tr></thead><tbody>
        {([['Contas a pagar', report.financial.payable], ['Contas a receber', report.financial.receivable]] as const).map(([label, bucket]) => <tr key={label} className="border-t border-slate-100"><td className="p-2 font-medium">{label}</td><td className="p-2">{bucket.count}</td><td className="p-2">{formatMoney(bucket.amount)}</td><td className="p-2">{formatMoney(bucket.paid)}</td><td className="p-2">{formatMoney(bucket.open)}</td><td className="p-2">{bucket.overdue}</td></tr>)}
        <tr className="border-t border-slate-100"><td className="p-2 font-medium">Saldos iniciais ({report.financial.initialBalances.accounts} conta(s))</td><td className="p-2" colSpan={5}>{formatMoney(report.financial.initialBalances.total)}</td></tr>
      </tbody></table></div></section>}
    <DataTable columns={[{ label: 'Módulo' }, { label: 'Origem' }, { label: 'Importados' }, { label: 'Duplicados' }, { label: 'Rejeitados' }, { label: 'Falhas' }, { label: 'Ignorados' }, { label: 'Pendentes' }, { label: 'Revertidos' }]}>
      {report.comparison.map(row => <tr key={row.entity}><td className="font-medium">{row.label}</td><td>{row.read}</td><td>{row.imported}</td><td>{row.duplicates}</td><td>{row.rejected}</td><td>{row.failed}</td><td>{row.ignored}</td><td>{row.pending}</td><td>{row.reverted}</td></tr>)}
    </DataTable>
    {(report.alerts.length > 0 || report.analysis.unreadableFiles.length > 0) && <section className={panelClass}><h4 className="font-semibold">Alertas e limitações</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{[...report.alerts, ...report.analysis.unreadableFiles.map(item => `${item.file}: ${item.message}`), ...report.analysis.warnings, ...report.analysis.limitations].map(text => <li key={text}>{text}</li>)}</ul></section>}
    {report.integrity.length > 0 && <section className={panelClass}><h4 className="font-semibold">Validação pós-migração</h4>
      <ul className="mt-2 space-y-1 text-sm">{report.integrity.map(check => <li key={check.name}><Badge tone={check.ok ? 'green' : 'red'}>{check.ok ? 'OK' : 'Falha'}</Badge> <b>{check.name}</b> — {check.detail}</li>)}</ul></section>}
    {(report.pendencies.length > 0 || report.errors.length > 0) && <section className={panelClass}><h4 className="font-semibold">Pendências e erros ({report.pendencies.length + report.errors.length})</h4>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-xs text-slate-700">{[...report.errors.map(item => ({ ...item, kind: 'Erro' })), ...report.pendencies.map(item => ({ ...item, kind: 'Pendente' }))].slice(0, 200).map((item, index) => <li key={index}><Badge tone={item.kind === 'Erro' ? 'red' : 'amber'}>{item.kind}</Badge> {item.table} · linha {item.row}: {item.messages.join(' · ') || '—'}</li>)}</ul></section>}
    <section className={panelClass}><h4 className="font-semibold">Correções automáticas ({report.corrections.total})</h4>
      <p className="mt-1 flex flex-wrap gap-2 text-xs">{Object.entries(report.corrections.byRule).map(([rule, count]) => <Badge key={rule}>{rule}: {count}</Badge>)}{report.corrections.total === 0 && <span className="text-slate-500">Nenhuma correção aplicada.</span>}</p>
      <p className="mt-2 text-xs text-slate-500">O valor original, o valor corrigido, a regra e o motivo de cada correção estão no CSV detalhado e na tela de pré-visualização.</p></section>
    <section className={panelClass}><h4 className="font-semibold">Backups desta migração</h4>
      {report.backups.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nenhum backup gerado pela plataforma para esta migração.</p> :
        <ul className="mt-2 space-y-1 text-sm">{report.backups.map(backup => <li key={backup.id}><Badge tone={backup.status === 'VERIFIED' ? 'green' : 'red'}>{backup.status === 'VERIFIED' ? 'Validado' : backup.status === 'INVALID' ? 'Inválido' : backup.status === 'FAILED' ? 'Falhou' : backup.status}</Badge> {formatDateTime(backup.createdAt)}{backup.restoreVerified ? ' · restauração testada' : ''}{backup.encrypted ? ' · criptografado' : ''}{backup.sha256 ? ` · SHA-256 ${backup.sha256.slice(0, 12)}…` : ''}{backup.error ? <span className="text-red-700"> · {backup.error}</span> : null}</li>)}</ul>}
    </section>
    <section className={panelClass}><h4 className="font-semibold">Linha do tempo</h4>
      <div className="mt-2 max-w-xs"><Select label="Filtrar por tipo de evento" value={eventPage.type} onChange={event => setEventPage({ page: 1, total: eventPage.total, type: event.target.value })}><option value="">Todos</option>{['CREATED', 'FILE_ADDED', 'ANALYZED', 'PREVIEWED', 'RECORD_REVIEWED', 'BACKUP_VERIFIED', 'BACKUP_FAILED', 'APPROVAL_BLOCKED', 'APPROVED', 'EXECUTION_BLOCKED', 'STARTED', 'BATCH_DONE', 'INTERRUPTED', 'RESUMED', 'COMPLETED', 'CANCELLED', 'ROLLBACK_DONE'].map(type => <option key={type} value={type}>{type}</option>)}</Select></div>
      <ol className="mt-2 max-h-80 space-y-1 overflow-y-auto text-sm">{events.map(event => <li key={event.id}><span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span> <Badge>{event.type}</Badge> {event.message} <span className="text-xs text-slate-500">— {event.actorName ?? (event.actorUserId ? 'usuário removido' : 'sistema')}</span></li>)}{events.length === 0 && <li className="text-slate-500">Nenhum evento.</li>}</ol>
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-600"><button type="button" className={secondaryButtonClass} disabled={eventPage.page <= 1} onClick={() => setEventPage({ ...eventPage, page: eventPage.page - 1 })}>‹ Mais recentes</button><span>Página {eventPage.page} de {Math.max(1, Math.ceil(eventPage.total / EVENT_PAGE_SIZE))} · {eventPage.total} evento(s)</span><button type="button" className={secondaryButtonClass} disabled={eventPage.page * EVENT_PAGE_SIZE >= eventPage.total} onClick={() => setEventPage({ ...eventPage, page: eventPage.page + 1 })}>Mais antigos ›</button></div></section>
  </div>;
}
