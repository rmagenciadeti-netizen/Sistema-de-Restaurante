'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { entityLabels, recordStatusLabels, recordTone, refLabels, type EntityKey, type StagedRecord } from '../../lib/types-migration';
import { formatMoney } from '../../lib/api';
import { buttonClass, inputClass, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState, StatCard } from '../ui';
import { editable, type StepProps } from './files-step';

const text = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);

export function PreviewStep({ base, session, caps, reload, notify }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ group: '', status: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: StagedRecord[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const summary = session.summary; const canEdit = session.status === 'PREVIEWED';
  const hasPreview = ['PREVIEWED', 'APPROVED', 'RUNNING', 'COMPLETED', 'INTERRUPTED', 'CANCELLED', 'ROLLED_BACK'].includes(session.status);

  const loadRecords = useCallback(async () => {
    if (!hasPreview) return;
    const query = new URLSearchParams({ page: String(page), pageSize: '15', ...(filter.group ? { group: filter.group } : {}), ...(filter.status ? { status: filter.status } : {}) });
    try { setData(await api<{ items: StagedRecord[]; total: number }>(`${base}/records?${query}`)); } catch (error) { notify(errorMessage(error, 'Falha ao carregar os registros')); }
  }, [base, filter, hasPreview, notify, page]);
  useEffect(() => { void loadRecords(); }, [loadRecords, session.updatedAt]);

  async function generate() {
    if (hasPreview && !confirm('Gerar novamente descarta as revisões manuais já feitas nesta pré-visualização. Continuar?')) return;
    setBusy(true);
    try { await api(`${base}/preview`, { method: 'POST', body: '{}' }); setPage(1); notify('Pré-visualização gerada.', true); } catch (error) { notify(errorMessage(error, 'Falha ao gerar a pré-visualização')); }
    finally { setBusy(false); await reload(); }
  }
  async function review(record: StagedRecord, body: unknown, done: string) {
    try { await api(`${base}/records/${record.id}`, { method: 'PATCH', body: JSON.stringify(body) }); notify(done, true); setOpen(null); setDraft({}); await reload(); await loadRecords(); }
    catch (error) { notify(errorMessage(error, 'Falha ao revisar o registro')); }
  }
  async function bulk() {
    try { const result = await api<{ approved: number }>(`${base}/bulk-approve`, { method: 'POST', body: '{}' }); notify(`${result.approved} registro(s) seguros aprovados.`, true); await reload(); await loadRecords(); }
    catch (error) { notify(errorMessage(error, 'Falha na aprovação em lote')); }
  }
  function startEdit(record: StagedRecord) { setOpen(record.id); setDraft(Object.fromEntries(Object.entries(record.normalized).map(([key, value]) => [key, value === null ? '' : String(value)]))); }
  function saveEdit(record: StagedRecord) {
    const values: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(draft)) if (value !== (record.normalized[key] === null ? '' : String(record.normalized[key] ?? ''))) values[key] = value === '' ? null : value;
    if (Object.keys(values).length === 0) { setOpen(null); return; }
    void review(record, { values }, 'Correção manual registrada na auditoria.');
  }

  const money = (value?: string) => formatMoney(value ?? '0');
  const financial = summary?.financial;
  const totals = summary?.byEntity ? Object.values(summary.byEntity).reduce((sum, bucket) => { for (const [key, value] of Object.entries(bucket)) sum[key] = (sum[key] ?? 0) + value; return sum; }, {} as Record<string, number>) : {};
  return <div className="space-y-4">
    <section className={panelClass}>
      <h3 className="text-base font-semibold">3. Pré-visualização e conferência</h3>
      <p className="mt-1 text-sm text-slate-600">Nada é gravado no restaurante nesta etapa. Registros inseguros ficam retidos até a sua decisão; correções preservam o valor original e registram regra e justificativa.</p>
      {editable(session.status) && <div className="mt-3"><button type="button" className={buttonClass} disabled={busy || !session.mapping} onClick={() => void generate()}>{hasPreview ? 'Gerar novamente' : 'Gerar pré-visualização'}</button></div>}
    </section>
    {!hasPreview || !summary ? <EmptyState icon="🔎" title="Pré-visualização ainda não gerada" hint="Aprove o mapeamento das tabelas e gere a pré-visualização." /> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="🗄️" label="Tabelas" value={summary.tablesFound ?? 0} hint={`${summary.tablesMapped ?? 0} aprovadas para importação`} />
        <StatCard icon="🧩" label="Campos" value={summary.fieldsRecognised ?? 0} hint={`${summary.fieldsWithoutMatch ?? 0} sem correspondência`} />
        <StatCard icon="✅" label="Válidos / a importar" value={`${totals.VALID ?? 0} / ${summary.importable ?? 0}`} />
        <StatCard icon="⚠️" label="Divergentes" value={totals.DIVERGENT ?? 0} hint={`${summary.pendingReview ?? 0} aguardando decisão`} />
        <StatCard icon="♻️" label="Duplicados" value={totals.DUPLICATE ?? 0} />
        <StatCard icon="⛔" label="Rejeitados" value={totals.REJECTED ?? 0} />
        <StatCard icon="🛠️" label="Correções propostas" value={summary.corrections ?? 0} />
        <StatCard icon="⏱️" label="Estimativa" value={`${summary.estimate?.batches ?? 0} lote(s)`} hint={`≈ ${summary.estimate?.seconds ?? 0}s de processamento`} />
      </div>
      {financial && (financial.payable.count > 0 || financial.receivable.count > 0 || financial.initialBalances.accounts > 0) && <section className={panelClass}>
        <h4 className="font-semibold">Valores financeiros a importar</h4>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {([['📤 Contas a pagar', financial.payable, 'pago'], ['📥 Contas a receber', financial.receivable, 'recebido']] as const).map(([label, bucket, paidWord]) => <div key={label} className="rounded-xl border border-slate-200 p-3 text-sm">
            <p className="font-semibold">{label} <span className="font-normal text-slate-500">({bucket.count})</span></p>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1"><dt className="text-slate-500">Valor original</dt><dd>{money(bucket.amount)}</dd><dt className="text-slate-500">Juros / descontos</dt><dd>{money(bucket.interest)} / {money(bucket.discount)}</dd><dt className="text-slate-500">Total {paidWord}</dt><dd>{money(bucket.paid)}</dd><dt className="text-slate-500">Saldo em aberto</dt><dd className="font-semibold">{money(bucket.open)}</dd></dl>
            <p className="mt-2 text-xs text-slate-600">{bucket.byStatus.open} em aberto · {bucket.byStatus.partial} parcial(is) · {bucket.byStatus.paid} {paidWord}(s) · {bucket.byStatus.cancelled} cancelado(s) · <b>{bucket.overdue} vencido(s)</b></p>
          </div>)}
          <div className="rounded-xl border border-slate-200 p-3 text-sm"><p className="font-semibold">🏦 Saldos iniciais <span className="font-normal text-slate-500">({financial.initialBalances.accounts} conta(s))</span></p><p className="mt-2 text-lg font-semibold">{money(financial.initialBalances.total)}</p><p className="mt-1 text-xs text-slate-500">Gravado como saldo inicial da conta bancária; nenhum movimento é criado.</p></div>
        </div>
      </section>}
      {summary.refs && Object.keys(summary.refs).length > 0 && <section className={panelClass}>
        <h4 className="font-semibold">Relacionamentos identificados</h4>
        <ul className="mt-2 grid gap-1 text-sm md:grid-cols-2">{Object.entries(summary.refs).map(([key, ref]) => <li key={key}><b>{refLabels[key] ?? key}</b>: {ref.resolved} vinculado(s){ref.derived > 0 && `, ${ref.derived} criado(s) a partir dos nomes`}{ref.unresolved > 0 && <span className="text-amber-700">, {ref.unresolved} sem vínculo (revisar)</span>}</li>)}</ul>
        {summary.installments && summary.installments.documents > 0 && <p className="mt-2 text-xs text-slate-600">{summary.installments.documents} documento(s) parcelado(s); {summary.installments.incomplete} com parcelas ausentes (não são inventadas).</p>}
      </section>}
      {summary.alerts?.map(alert => <p key={alert} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{alert}</p>)}
      <section className={panelClass}>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Grupo de dados" value={filter.group} onChange={event => { setPage(1); setFilter({ ...filter, group: event.target.value }); }}><option value="">Todos</option>{caps.groups.map(group => <option key={group.key} value={group.key}>{group.icon} {group.label}</option>)}</Select>
          <Select label="Situação" value={filter.status} onChange={event => { setPage(1); setFilter({ ...filter, status: event.target.value }); }}><option value="">Todas</option>{Object.entries(recordStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
          {canEdit && <button type="button" className={secondaryButtonClass} onClick={() => void bulk()}>Aprovar tudo que estiver seguro</button>}
        </div>
        <div className="mt-4"><DataTable columns={[{ label: 'Módulo' }, { label: 'Origem' }, { label: 'Registro' }, { label: 'Situação' }, { label: 'Observações' }, { label: '' }]} footer={`${data.total} registro(s) · página ${page}`}>
          {data.items.map(record => <Fragment key={record.id}>
            <tr><td>{entityLabels[record.entity]}</td><td className="text-xs text-slate-500">{record.tableName} · linha {record.rowIndex + 2}</td><td className="font-medium">{text(record.normalized.name ?? record.normalized.description)}{record.normalized.amount ? <div className="text-xs font-normal text-slate-500">{formatMoney(String(record.normalized.amount))}{record.normalized.dueAt ? ` · venc. ${String(record.normalized.dueAt).split('-').reverse().join('/')}` : ''}</div> : null}</td>
              <td><Badge tone={recordTone(record.status)}>{recordStatusLabels[record.status] ?? record.status}</Badge>{record.status === 'DIVERGENT' && record.approved && <Badge tone="green">aprovado</Badge>}</td>
              <td className="max-w-[320px] text-xs text-slate-600">{[...record.issues.filter(issue => issue.severity !== 'info').map(issue => issue.message), ...(record.error ? [record.error] : [])].slice(0, 2).join(' · ') || (record.corrections.length ? `${record.corrections.length} correção(ões) segura(s)` : '—')}</td>
              <td className="text-right"><button type="button" className={secondaryButtonClass} onClick={() => setOpen(open === record.id ? null : record.id)}>{open === record.id ? 'Fechar' : 'Detalhes'}</button></td></tr>
            {open === record.id && <tr><td colSpan={6} className="bg-slate-50"><RecordDetail record={record} entities={caps.entities} canEdit={canEdit} draft={draft} setDraft={setDraft} onEdit={() => startEdit(record)} onSave={() => saveEdit(record)} review={(body, done) => void review(record, body, done)} /></td></tr>}
          </Fragment>)}
        </DataTable></div>
        {data.total > 15 && <div className="mt-3 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><button type="button" className={secondaryButtonClass} disabled={page * 15 >= data.total} onClick={() => setPage(page + 1)}>Próxima</button></div>}
      </section>
    </>}
  </div>;
}

function RecordDetail({ record, entities, canEdit, draft, setDraft, onEdit, onSave, review }: { record: StagedRecord; entities: { key: EntityKey; fields: { key: string; label: string; kind: string }[] }[]; canEdit: boolean; draft: Record<string, string>; setDraft: (value: Record<string, string>) => void; onEdit: () => void; onSave: () => void; review: (body: unknown, done: string) => void }) {
  const editing = Object.keys(draft).length > 0;
  const fields = entities.find(entity => entity.key === record.entity)?.fields.map(field => ({ ...field, key: field.kind === 'ref' ? field.key.replace(/Ref$/, 'Name') : field.key })) ?? [];
  const locked = ['IMPORTED', 'REVERTED'].includes(record.status);
  return <div className="grid gap-4 p-3 lg:grid-cols-2">
    <div><h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">Valor original (preservado)</h5>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{Object.entries(record.original).map(([key, value]) => <Fragment key={key}><dt className="text-slate-500">{key}</dt><dd className="break-all">{text(value)}</dd></Fragment>)}</dl></div>
    <div><h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">Valor para importação</h5>
      <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">{fields.map(field => <Fragment key={field.key}><dt className="text-slate-500">{field.label}</dt><dd>{editing ? <input className={`${inputClass} !mt-0 !py-1`} value={draft[field.key] ?? ''} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} /> : text(record.normalized[field.key])}</dd></Fragment>)}</dl></div>
    {record.corrections.length > 0 && <div className="lg:col-span-2"><h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">Correções aplicadas</h5>
      <ul className="mt-1 space-y-1 text-xs">{record.corrections.map((correction, index) => <li key={index}><b>{correction.field}</b>: “{text(correction.original)}” → “{text(correction.corrected)}” <span className="text-slate-500">[{correction.rule}] {correction.reason}</span></li>)}</ul></div>}
    {record.issues.length > 0 && <div className="lg:col-span-2"><h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">Ocorrências</h5>
      <ul className="mt-1 space-y-1 text-xs">{record.issues.map((issue, index) => <li key={index}><Badge tone={issue.severity === 'error' ? 'red' : issue.severity === 'review' ? 'amber' : 'neutral'}>{issue.severity === 'error' ? 'erro' : issue.severity === 'review' ? 'revisar' : 'info'}</Badge> {issue.message}{issue.suggestion && <span className="text-slate-500"> — Sugestão: {issue.suggestion}</span>}</li>)}</ul></div>}
    {canEdit && !locked && <div className="flex flex-wrap gap-2 lg:col-span-2">
      {editing ? <button type="button" className={buttonClass} onClick={onSave}>Salvar correção</button> : <button type="button" className={secondaryButtonClass} onClick={onEdit}>Corrigir manualmente</button>}
      {['DIVERGENT', 'VALID'].includes(record.status) && (record.approved ? <button type="button" className={secondaryButtonClass} onClick={() => review({ approve: false }, 'Aprovação removida.')}>Retirar aprovação</button> : <button type="button" className={buttonClass} onClick={() => review({ approve: true }, 'Registro aprovado para importação.')}>Aprovar assim mesmo</button>)}
      {record.status === 'IGNORED' ? <button type="button" className={secondaryButtonClass} onClick={() => review({ ignore: false }, 'Registro reativado.')}>Reativar</button> : <button type="button" className={secondaryButtonClass} onClick={() => review({ ignore: true }, 'Registro ignorado.')}>Ignorar registro</button>}
    </div>}
  </div>;
}
