'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

type AuditEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: string;
  actor: { id: string; name: string } | null;
};
type Filters = { action: string; entityType: string; from: string; to: string };
const emptyFilters: Filters = { action: '', entityType: '', from: '', to: '' };
const pageSize = 50;

function isoDate(value: string) {
  return value ? new Date(`${value}T00:00:00`).toISOString() : '';
}

export default function AuditPage() {
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load(nextPage: number, selected: Filters) {
    const query = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
    if (selected.action) query.set('action', selected.action);
    if (selected.entityType) query.set('entityType', selected.entityType);
    const from = isoDate(selected.from); const to = isoDate(selected.to);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const result = await api<ListResponse<AuditEntry>>(`/audit?${query}`);
    setItems(result.items); setTotal(result.total); setPage(nextPage); setApplied(selected);
  }

  useAutoLoad(async () => {
    try { await load(1, emptyFilters); }
    catch (error) { setMessage(errorMessage(error, 'Erro ao carregar auditoria')); }
  });

  async function refresh(nextPage: number, selected: Filters) {
    setBusy(true); setMessage('');
    try { await load(nextPage, selected); }
    catch (error) { setMessage(errorMessage(error, 'Erro ao carregar auditoria')); }
    finally { setBusy(false); }
  }

  return <AppShell title="Auditoria">
    <p className="mb-5 text-sm text-slate-400">Histórico de alterações administrativas da empresa. Os registros são somente leitura e não incluem eventos de outras empresas.</p>
    {message && <Notice message={message} />}
    <section className={`${panelClass} mb-6`}>
      <h2 className="mb-4 text-lg font-semibold">Filtrar histórico</h2>
      <form className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" onSubmit={event => { event.preventDefault(); void refresh(1, filters); }}>
        <Field label="Ação" maxLength={100} value={filters.action} onChange={event => setFilters({ ...filters, action: event.target.value })} placeholder="Ex.: USER_UPDATED" />
        <Field label="Tipo de registro" maxLength={100} value={filters.entityType} onChange={event => setFilters({ ...filters, entityType: event.target.value })} placeholder="Ex.: User" />
        <Field label="A partir de" type="date" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} />
        <Field label="Até" type="date" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} />
        <button className={buttonClass} disabled={busy}>Filtrar</button>
      </form>
    </section>
    <section className={panelClass}>
      <h2 className="mb-4 text-lg font-semibold">Eventos ({total})</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="p-2">Data</th><th className="p-2">Responsável</th><th className="p-2">Ação</th><th className="p-2">Registro</th><th className="p-2">Detalhes</th></tr></thead>
          <tbody>{items.map(item => <tr key={item.id} className="border-t border-slate-800 align-top">
            <td className="whitespace-nowrap p-2">{formatDateTime(item.createdAt)}</td>
            <td className="p-2">{item.actor?.name ?? 'Usuário removido'}</td>
            <td className="p-2">{item.action}</td>
            <td className="p-2">{item.entityType}{item.entityId && <div className="max-w-48 break-all text-xs text-slate-500">{item.entityId}</div>}</td>
            <td className="max-w-lg p-2"><pre className="whitespace-pre-wrap break-words text-xs text-slate-300">{item.metadata ? JSON.stringify(item.metadata, null, 2) : '—'}</pre></td>
          </tr>)}</tbody>
        </table>
      </div>
      {items.length === 0 && <p className="mt-3 text-sm text-slate-400">Nenhum evento encontrado.</p>}
      <div className="mt-4 flex items-center gap-3 text-sm text-slate-400">
        <button className={secondaryButtonClass} disabled={busy || page <= 1} onClick={() => void refresh(page - 1, applied)}>Anterior</button>
        <span>Página {page} · {total} evento(s)</span>
        <button className={secondaryButtonClass} disabled={busy || page * pageSize >= total} onClick={() => void refresh(page + 1, applied)}>Próxima</button>
      </div>
    </section>
  </AppShell>;
}
