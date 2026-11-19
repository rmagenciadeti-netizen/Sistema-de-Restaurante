'use client';

import { useRef, useState } from 'react';
import { api, errorMessage, uploadFile } from '../../lib/api';
import type { Capabilities, SessionDetail } from '../../lib/types-migration';
import { buttonClass, Check, panelClass } from '../app-shell';
import { Badge, DataTable, dangerButtonClass, EmptyState } from '../ui';

export type StepProps = { base: string; session: SessionDetail; caps: Capabilities; reload: () => Promise<void>; notify: (message: string, ok?: boolean) => void };
export const editable = (status: string) => ['DRAFT', 'ANALYZED', 'PREVIEWED'].includes(status);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 ? 1 : 2)} MB`;

export function FilesStep({ base, session, caps, reload, notify }: StepProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const canEdit = editable(session.status);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        try { await uploadFile(`${base}/files?name=${encodeURIComponent(file.name)}`, file); notify(`Arquivo "${file.name}" enviado.`, true); }
        catch (error) { notify(`${file.name}: ${errorMessage(error, 'falha no envio')}`); }
      }
      await reload();
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function analyze() {
    setBusy(true);
    try { await api(`${base}/analyze`, { method: 'POST', body: JSON.stringify({ useAi }) }); notify('Análise concluída. Revise o mapeamento sugerido.', true); }
    catch (error) { notify(errorMessage(error, 'Falha na análise')); }
    finally { setBusy(false); await reload(); }
  }
  async function remove(id: string) {
    if (!confirm('Remover o arquivo? A análise e o mapeamento atuais serão descartados.')) return;
    try { await api(`${base}/files/${id}`, { method: 'DELETE' }); await reload(); } catch (error) { notify(errorMessage(error, 'Falha ao remover')); }
  }

  const analysis = session.analysis;
  return <div className="space-y-4">
    <section className={panelClass}>
      <h3 className="text-base font-semibold">1. Envio de arquivos e backups</h3>
      <p className="mt-1 text-sm text-slate-600">Aceitos: {caps.formats.map(format => format.label).join(', ')}. Limites: {caps.limits.maxFiles} arquivos por sessão, {megabytes(caps.limits.maxFileBytes)} por arquivo, {caps.limits.maxRowsPerTable.toLocaleString('pt-BR')} linhas por tabela. Nenhum conteúdo do arquivo é executado; SQL é apenas lido.</p>
      <p className="mt-1 text-xs text-amber-700">Ainda não suportados: {caps.unsupportedFormats.join('; ')}. Para esses casos peça uma exportação alternativa (CSV/XLSX/JSON/XML/dump SQL em texto).</p>
      {canEdit && <div className="mt-4 flex flex-wrap items-center gap-3">
        <input ref={input} type="file" multiple accept=".csv,.txt,.tsv,.xlsx,.json,.xml,.sql" className="hidden" onChange={event => void upload(event.target.files)} />
        <button type="button" className={buttonClass} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Processando…' : 'Enviar arquivos'}</button>
        <Check label="Usar a IA do RM para colunas ambíguas" checked={useAi} disabled={!caps.aiAvailable} onChange={event => setUseAi(event.target.checked)} />
        {!caps.aiAvailable && <span className="text-xs text-slate-500">IA não configurada neste servidor: apenas regras determinísticas.</span>}
      </div>}
    </section>
    {session.files.length === 0 ? <EmptyState icon="🗂️" title="Nenhum arquivo enviado" hint="Envie o backup ou as planilhas exportadas do sistema antigo do restaurante." /> : <>
      <DataTable columns={[{ label: 'Arquivo' }, { label: 'Tamanho' }, { label: 'Formato' }, { label: 'SHA-256' }, { label: '' }]}>
        {session.files.map(file => <tr key={file.id}><td className="font-medium">{file.name}</td><td>{megabytes(file.size)}</td><td>{file.format === 'pending' ? <Badge>aguardando análise</Badge> : <Badge tone="gold">{file.format}</Badge>}</td><td className="font-mono text-xs text-slate-500">{file.sha256.slice(0, 16)}…{file.purgedAt && <Badge tone="amber">conteúdo descartado</Badge>}</td><td className="text-right">{canEdit && <button type="button" className={dangerButtonClass} onClick={() => void remove(file.id)}>Remover</button>}</td></tr>)}
      </DataTable>
      {canEdit && <div><button type="button" className={buttonClass} disabled={busy} onClick={() => void analyze()}>{analysis ? 'Refazer análise' : 'Solicitar análise automática'}</button></div>}
    </>}
    {analysis && <section className={panelClass}>
      <h3 className="text-base font-semibold">Resultado da leitura</h3>
      {analysis.errors.map(item => <p key={item.file} className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"><b>{item.file}:</b> {item.message}</p>)}
      {[...analysis.warnings, ...analysis.limitations, ...(analysis.ai?.warnings ?? [])].map(text => <p key={text} className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{text}</p>)}
      {analysis.ai && analysis.ai.calls + analysis.ai.applied > 0 && <p className="mt-2 text-sm text-slate-600">IA: {analysis.ai.calls} consulta(s), {analysis.ai.applied} coluna(s) sugerida(s) (sempre marcadas para revisão).</p>}
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="p-2">Tabela</th><th className="p-2">Linhas</th><th className="p-2">Colunas, tipos e amostras</th></tr></thead><tbody>
        {analysis.tables.map(table => <tr key={table.key} className="border-t border-slate-100 align-top"><td className="p-2 font-medium">{table.name}<div className="text-xs text-slate-500">{table.file}</div></td><td className="p-2">{table.rowCount.toLocaleString('pt-BR')}{table.truncated && <Badge tone="amber">limitada</Badge>}</td>
          <td className="p-2"><div className="flex flex-wrap gap-1.5">{table.columns.map(column => <span key={column.name} title={column.samples.join(' | ')} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs"><b>{column.name}</b> <span className="text-slate-500">{column.type ?? column.dominant}</span></span>)}</div></td></tr>)}
      </tbody></table></div>
    </section>}
  </div>;
}
