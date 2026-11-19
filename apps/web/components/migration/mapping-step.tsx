'use client';

import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { entityLabels, entityOrder, sourceLabels, type EntityKey, type MappingTable } from '../../lib/types-migration';
import { buttonClass, inputClass, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge, EmptyState } from '../ui';
import { editable, type StepProps } from './files-step';

type Edit = { entity?: EntityKey | 'IGNORE'; columns: Record<string, string | null> };
const levelTone = (level: string) => level === 'direct' ? 'green' : level === 'probable' ? 'amber' : level === 'low' ? 'red' : 'neutral';
const levelLabel: Record<string, string> = { direct: 'Direta', probable: 'Provável', low: 'Baixa', none: '—' };

export function MappingStep({ base, session, caps, reload, notify }: StepProps) {
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState('');
  const mapping = session.mapping; const analysis = session.analysis;
  const canEdit = editable(session.status);
  if (!mapping || !analysis) return <EmptyState icon="🧭" title="Ainda não há análise" hint="Envie os arquivos e solicite a análise automática na etapa anterior." />;
  const names = new Map(Object.values(mapping.tables).map(table => [table.key, table.name]));
  const groupOf = (entity: string) => caps.groups.find(group => (group.entities as string[]).includes(entity));
  const sorted = Object.values(mapping.tables).sort((a, b) => entityOrder.indexOf(a.entity) - entityOrder.indexOf(b.entity));

  const entityOf = (table: MappingTable) => edits[table.key]?.entity ?? table.entity;
  const fieldsOf = (entity: string) => caps.entities.find(item => item.key === entity)?.fields ?? [];
  const targetOf = (table: MappingTable, column: string) => { const edit = edits[table.key]?.columns; return edit && column in edit ? edit[column] : table.columns[column].target; };
  const patch = (table: MappingTable, change: Partial<Edit>) => setEdits(current => ({ ...current, [table.key]: { ...current[table.key], ...change, columns: { ...current[table.key]?.columns, ...change.columns } } }));

  async function save(table: MappingTable, approved: boolean) {
    const edit = edits[table.key]; setBusy(table.key);
    try {
      await api(`${base}/mapping`, { method: 'PUT', body: JSON.stringify({ tables: { [table.key]: { ...(edit?.entity ? { entity: edit.entity } : {}), ...(edit && Object.keys(edit.columns).length ? { columns: edit.columns } : {}), approved } } }) });
      setEdits(current => { const next = { ...current }; delete next[table.key]; return next; });
      notify(approved ? `Mapeamento de "${table.name}" aprovado e guardado para reutilização.` : 'Mapeamento salvo.', true);
    } catch (error) { notify(errorMessage(error, 'Falha ao salvar o mapeamento')); } finally { setBusy(''); await reload(); }
  }

  return <div className="space-y-4">
    <section className={panelClass}>
      <h3 className="text-base font-semibold">2. Mapeamento origem → RM Restaurant</h3>
      <p className="mt-1 text-sm text-slate-600">Cada coluna mostra a confiança e o motivo da associação (nome, conteúdo e relações). Sugestões da IA ou por eliminação exigem sua revisão. Somente tabelas <b>aprovadas</b> entram na pré-visualização.</p>
    </section>
    {sorted.map(table => {
      const entity = entityOf(table); const fields = fieldsOf(entity); const detail = analysis.tables.find(item => item.key === table.key);
      const targets = Object.keys(table.columns).map(column => targetOf(table, column)).filter(Boolean) as string[];
      const missing = entity === 'IGNORE' ? [] : fields.filter(field => field.required && !targets.includes(field.key));
      const dirty = Boolean(edits[table.key]);
      return <section key={table.key} className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h4 className="font-semibold">{groupOf(entity) && <span className="mr-2"><Badge tone="gold">{groupOf(entity)!.icon} {groupOf(entity)!.label}</Badge></span>}{table.name} <span className="text-xs font-normal text-slate-500">({table.file} · {detail?.rowCount.toLocaleString('pt-BR') ?? 0} linhas)</span></h4><p className="mt-1 text-xs text-slate-600">{table.entityReason}</p></div>
          <div className="flex items-center gap-2">{table.approved && !dirty ? <Badge tone="green">Aprovada</Badge> : <Badge tone="neutral">Pendente</Badge>}
            <select aria-label={`Destino de ${table.name}`} className={`${inputClass} !mt-0 w-auto`} disabled={!canEdit} value={entity} onChange={event => patch(table, { entity: event.target.value as EntityKey | 'IGNORE' })}>
              {entityOrder.map(key => <option key={key} value={key}>{entityLabels[key]}</option>)}
            </select></div>
        </div>
        {entity !== 'IGNORE' && missing.length > 0 && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">Campos obrigatórios sem origem: {missing.map(field => field.label).join(', ')}. Associe uma coluna ou ignore a tabela.</p>}
        {entity !== 'IGNORE' && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="p-2">Coluna de origem</th><th className="p-2">Amostras</th><th className="p-2">Campo no RM</th><th className="p-2">Confiança</th><th className="p-2">Motivo</th></tr></thead><tbody>
          {Object.entries(table.columns).map(([column, info]) => {
            const samples = detail?.columns.find(item => item.name === column)?.samples ?? [];
            const operatorEdited = edits[table.key]?.columns && column in edits[table.key].columns;
            return <tr key={column} className="border-t border-slate-100 align-top">
              <td className="p-2 font-medium">{column}{table.sourceKey === column && <span className="ml-1 text-[10px] text-slate-500">(chave)</span>}</td>
              <td className="max-w-[200px] truncate p-2 text-xs text-slate-500" title={samples.join(' | ')}>{samples.slice(0, 3).join(' · ')}</td>
              <td className="p-2"><select aria-label={`Campo para ${column}`} className={`${inputClass} !mt-0`} disabled={!canEdit} value={targetOf(table, column) ?? ''} onChange={event => patch(table, { columns: { [column]: event.target.value || null } })}>
                <option value="">— não importar —</option>{fields.map(field => <option key={field.key} value={field.key}>{field.label}{field.required ? ' *' : ''}</option>)}</select></td>
              <td className="p-2">{operatorEdited ? <Badge tone="blue">Operador</Badge> : <div className="flex flex-wrap items-center gap-1"><Badge tone={levelTone(info.level)}>{levelLabel[info.level]} {info.confidence > 0 ? `${Math.round(info.confidence * 100)}%` : ''}</Badge>{info.target && <Badge>{sourceLabels[info.source]}</Badge>}{info.needsReview && <Badge tone="amber">revisar</Badge>}</div>}</td>
              <td className="p-2 text-xs text-slate-600">{operatorEdited ? 'Definido pelo operador.' : info.reason}</td></tr>;
          })}
        </tbody></table></div>}
        {canEdit && <div className="mt-4 flex flex-wrap gap-2">
          {entity !== 'IGNORE' && (!table.approved || dirty) && <button type="button" className={buttonClass} disabled={busy === table.key || missing.length > 0} onClick={() => void save(table, true)}>Aprovar mapeamento</button>}
          {entity === 'IGNORE' && (!table.approved || dirty) && <button type="button" className={buttonClass} disabled={busy === table.key} onClick={() => void save(table, true)}>Confirmar: ignorar tabela</button>}
          {dirty && <button type="button" className={secondaryButtonClass} disabled={busy === table.key} onClick={() => void save(table, false)}>Salvar sem aprovar</button>}
          {table.approved && !dirty && <button type="button" className={secondaryButtonClass} disabled={busy === table.key} onClick={() => void save(table, false)}>Remover aprovação</button>}
        </div>}
      </section>;
    })}
    {mapping.relationships.length > 0 && <section className={panelClass}>
      <h4 className="font-semibold">Relacionamentos detectados</h4>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">{mapping.relationships.map((relation, index) => <li key={index}>{names.get(relation.from.table)}.<b>{relation.from.column}</b> → {names.get(relation.to.table)}.<b>{relation.to.column}</b> <span className="text-xs text-slate-500">({Math.round(relation.matchRatio * 100)}% dos valores conferem)</span></li>)}</ul>
    </section>}
  </div>;
}
