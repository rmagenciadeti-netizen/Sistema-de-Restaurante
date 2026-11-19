'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { outcomeLabels, outcomeTone, statusLabels } from '../../lib/types-migration';
import { buttonClass, Check, Field, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge, dangerButtonClass, StatCard } from '../ui';
import type { StepProps } from './files-step';

type BackupItem = { id: string; status: string; stage?: string | null; error?: string | null; createdAt: string; verifiedAt?: string | null; sha256?: string | null; encrypted: boolean; verification?: { restore?: { mode?: string; tables?: { match: boolean }[] } } | null };
const backupLabel: Record<string, string> = { VERIFIED: 'Validado (restauração testada)', FAILED: 'Falhou', INVALID: 'Inválido', CREATING: 'Em andamento' };

export function RunStep({ base, session, caps, reload, notify }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [rollbackPhrase, setRollbackPhrase] = useState('');
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const summary = session.summary; const status = session.status;

  const loadBackups = useCallback(async () => {
    try { setBackups((await api<{ items: BackupItem[] }>(`${base}/backups`)).items); } catch { setBackups([]); }
  }, [base]);
  useAutoLoad(loadBackups);
  const latestBackup = backups[0];
  const backupReady = latestBackup?.status === 'VERIFIED';

  // The panel polls while a (possibly background) run is in progress.
  useEffect(() => {
    if (status !== 'RUNNING') return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [status, reload]);

  async function run(label: string, path: string, body: unknown = {}, ok?: (result: any) => string) {
    setBusy(true);
    try { const result = await api<any>(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) }); notify(ok ? ok(result) : `${label} concluído.`, true); }
    catch (error) { notify(errorMessage(error, `Falha: ${label}`)); }
    finally { setBusy(false); await reload(); await loadBackups(); }
  }
  const imported = Object.values(summary?.byEntity ?? {}).reduce((sum, bucket) => sum + (bucket.IMPORTED ?? 0), 0);
  const importable = summary?.importable ?? 0;
  const pending = (summary?.pendingReview ?? 0);
  const processedShare = imported + importable > 0 ? Math.round((imported / (imported + importable)) * 100) : 0;

  return <div className="space-y-4">
    <section className={panelClass}>
      <div className="flex flex-wrap items-center gap-3"><h3 className="text-base font-semibold">4. Autorização e execução</h3><Badge tone="gold">{statusLabels[status]}</Badge>{session.outcome && <Badge tone={outcomeTone(session.outcome)}>{outcomeLabels[session.outcome]}</Badge>}</div>
      <p className="mt-1 text-sm text-slate-600">A execução usa lotes, transações por registro e controle de retomada; registros já importados nunca são duplicados. Somente um restaurante-alvo por sessão e uma execução por vez por restaurante.</p>
      {['DRAFT', 'ANALYZED'].includes(status) && <p className="mt-3 text-sm text-amber-800">Gere a pré-visualização antes de autorizar a execução.</p>}

      {status === 'PREVIEWED' && <div className="mt-4 space-y-3 rounded-xl border border-brand-500/40 bg-brand-50/40 p-4">
        <p className="text-sm"><b>{importable}</b> registro(s) serão gravados no restaurante de destino. {pending > 0 && <span className="text-amber-800">{pending} divergência(s) sem decisão ficarão de fora.</span>}</p>
        <Check label="Conferi a pré-visualização e autorizo gravar estes dados neste restaurante." checked={ack} onChange={event => setAck(event.target.checked)} />
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-sm font-semibold">Backup recuperável deste restaurante {caps.backupRequired ? <Badge tone="red">obrigatório em produção</Badge> : <Badge>recomendado</Badge>}</p>
          <p className="text-xs text-slate-600">O sistema gera o backup, grava o arquivo com criptografia, confere a integridade e restaura uma cópia em ambiente isolado para comparar os dados. Só um backup validado desta migração libera a autorização.</p>
          {latestBackup && <p className="text-sm"><Badge tone={backupReady ? 'green' : 'red'}>{backupLabel[latestBackup.status] ?? latestBackup.status}</Badge> <span className="text-slate-600">gerado em {new Date(latestBackup.createdAt).toLocaleString('pt-BR')}{latestBackup.sha256 ? ` · SHA-256 ${latestBackup.sha256.slice(0, 12)}…` : ''}{latestBackup.verification?.restore?.mode ? ` · restauração: ${latestBackup.verification.restore.mode === 'separate-database' ? 'banco isolado' : 'esquema temporário isolado'}` : ''}</span></p>}
          {latestBackup?.error && !backupReady && <p className="text-sm text-red-700">{latestBackup.error}</p>}
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void run('Backup', '/backups', {}, () => 'Backup gerado e restauração validada.')}>{busy ? 'Processando…' : backupReady ? 'Gerar novo backup' : 'Gerar e validar backup'}</button>
        </div>
        <div className="max-w-xs"><Field label='Digite "EXECUTAR" para confirmar' value={phrase} onChange={event => setPhrase(event.target.value)} /></div>
        <button type="button" className={buttonClass} disabled={busy || !ack || phrase !== 'EXECUTAR' || (caps.backupRequired && !backupReady)} onClick={() => void run('Aprovação', '/approve', { confirm: 'EXECUTAR' }, () => 'Execução autorizada.')}>Autorizar execução</button>
      </div>}

      {status === 'APPROVED' && <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('Execução', '/execute', {}, result => result.status === 'RUNNING' ? 'Migração iniciada em segundo plano.' : `Execução finalizada: ${result.outcome ? outcomeLabels[result.outcome] : result.status}.`)}>{busy ? 'Executando…' : 'Executar migração'}</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void run('Reabertura', '/reopen')}>Revogar aprovação</button>
      </div>}

      {status === 'RUNNING' && <div className="mt-4"><div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={processedShare} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-brand-500 transition-all" style={{ width: `${processedShare}%` }} /></div><p className="mt-2 text-sm text-slate-700">Em andamento… {processedShare}% · {imported} registro(s) importados, {importable} restantes. <button type="button" className={`${dangerButtonClass} ml-2`} onClick={() => void run('Parada', '/cancel', {}, result => result.pending ? 'Parada solicitada; a execução termina o registro atual e para.' : 'Migração cancelada.')}>Parar</button></p></div>}

      {status === 'INTERRUPTED' && <div className="mt-4 space-y-2"><p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">A execução foi interrompida. Retomar continua apenas dos registros ainda pendentes, sem duplicar o que já foi importado.</p>
        <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void run('Retomada', '/resume', {}, result => `Retomada: ${result.outcome ? outcomeLabels[result.outcome] : result.status}.`)}>Retomar execução</button><button type="button" className={dangerButtonClass} onClick={() => void run('Cancelamento', '/cancel')}>Cancelar</button></div></div>}

      {['DRAFT', 'ANALYZED', 'PREVIEWED', 'APPROVED'].includes(status) && <div className="mt-4"><button type="button" className={dangerButtonClass} disabled={busy} onClick={() => { if (confirm('Cancelar esta migração? Os arquivos e a análise serão mantidos apenas para consulta.')) void run('Cancelamento', '/cancel'); }}>Cancelar migração</button></div>}
    </section>

    {summary?.byEntity && Object.keys(summary.byEntity).length > 0 && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {caps.groups.map(group => {
        const bucket = group.entities.reduce((sum, entity) => { const row = summary.byEntity?.[entity]; for (const key of ['total', 'IMPORTED', 'DUPLICATE', 'REJECTED', 'FAILED', 'DIVERGENT', 'VALID']) sum[key] = (sum[key] ?? 0) + (row?.[key] ?? 0); return sum; }, {} as Record<string, number>);
        if (!bucket.total) return null;
        return <StatCard key={group.key} icon={group.icon} label={group.label} value={`${bucket.IMPORTED ?? 0} / ${bucket.total}`} hint={`${bucket.DUPLICATE ?? 0} duplicados · ${bucket.REJECTED ?? 0} rejeitados · ${bucket.FAILED ?? 0} falhas · ${(bucket.DIVERGENT ?? 0) + (bucket.VALID ?? 0)} pendentes`} />;
      })}
    </div>}

    {['COMPLETED', 'INTERRUPTED', 'CANCELLED'].includes(status) && imported > 0 && <section className={panelClass}>
      <h4 className="font-semibold">Reversão</h4>
      <p className="mt-1 text-sm text-slate-600">Remove somente o que <b>esta migração criou</b> e que não foi usado nem alterado depois (pedidos, estoque, edições). O que não puder ser revertido com segurança é bloqueado e listado.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3"><div className="max-w-xs"><Field label='Digite "REVERTER" para confirmar' value={rollbackPhrase} onChange={event => setRollbackPhrase(event.target.value)} /></div>
        <button type="button" className={dangerButtonClass} disabled={busy || rollbackPhrase !== 'REVERTER'} onClick={() => void run('Reversão', '/rollback', { confirm: 'REVERTER' }, result => `Reversão: ${result.reverted} revertido(s), ${result.blocked.length} bloqueado(s).`)}>Reverter migração</button></div>
    </section>}

    {['COMPLETED', 'CANCELLED', 'ROLLED_BACK'].includes(status) && session.files.some(file => !file.purgedAt) && <section className={panelClass}>
      <h4 className="font-semibold">Retenção de arquivos</h4>
      <p className="mt-1 text-sm text-slate-600">Os arquivos do cliente ficam guardados no servidor. Descarte o conteúdo quando a migração estiver validada; relatório e auditoria são mantidos.</p>
      <button type="button" className={`${dangerButtonClass} mt-3`} onClick={() => { if (confirm('Descartar definitivamente o conteúdo dos arquivos enviados?')) void run('Descarte', '/purge-files', {}, result => `${result.purged} arquivo(s) descartado(s).`); }}>Descartar conteúdo dos arquivos</button>
    </section>}
  </div>;
}
