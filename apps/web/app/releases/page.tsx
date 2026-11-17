'use client';

import { useState } from 'react';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';
import { api, errorMessage, formatDateTime, type ListResponse } from '../../lib/api';
import { releaseActionLabels, type PasswordReleaseRow, type ReleaseAction } from '../../lib/types-settings';
import { useAutoLoad } from '../../lib/use-auto-load';

const PAGE_SIZE = 20;

export default function ReleasesPage() {
  const [items, setItems] = useState<PasswordReleaseRow[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');

  async function load(nextPage = page, range = { from, to }) {
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    try {
      const result = await api<ListResponse<PasswordReleaseRow>>(`/releases?${params}`);
      setItems(result.items); setTotal(result.total); setPage(nextPage);
    } catch (e) { setError(errorMessage(e, 'Erro ao carregar as liberações')); } finally { setLoading(false); }
  }
  useAutoLoad(() => load(1));

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(from || to);
  const invalidRange = Boolean(from && to && from > to);

  return <AppShell title="Liberações por senha">
    <PageHeader title="Liberações por senha" subtitle="Histórico de ações autorizadas com a senha de administrador (cancelamentos, descontos, sangrias…). A senha em si nunca é registrada." />
    {error && <Notice message={error} />}
    <form className={`${panelClass} mb-4 flex flex-wrap items-end gap-3`} onSubmit={event => { event.preventDefault(); if (!invalidRange) void load(1); }}>
      <Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} />
      <Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} />
      <button type="submit" disabled={invalidRange || loading} className={buttonClass}>Filtrar</button>
      {filtered && <button type="button" className={secondaryButtonClass} onClick={() => { setFrom(''); setTo(''); void load(1, { from: '', to: '' }); }}>Limpar</button>}
      {invalidRange && <span role="alert" className="text-sm text-red-700">A data inicial deve ser anterior à final.</span>}
    </form>
    {!loading && items.length === 0 && !error
      ? <EmptyState icon="🛡️" title={filtered ? 'Nenhuma liberação neste período' : 'Nenhuma liberação registrada'} hint={filtered ? 'Tente ampliar o intervalo de datas.' : 'Quando alguém precisar da senha de administrador para uma ação protegida, ela aparece aqui.'} />
      : <DataTable columns={[{ label: 'Ação' }, { label: 'Usuário' }, { label: 'Pedido' }, { label: 'Motivo' }, { label: 'Data' }]} footer={`${total} liberação(ões) · página ${page} de ${pages}`}>
        {items.map(item => <tr key={item.id}>
          <td><Badge tone={item.action === 'CANCEL_ORDER' ? 'red' : 'gold'}>{releaseActionLabels[item.action as ReleaseAction] ?? item.action}</Badge></td>
          <td>{item.requestedByName ?? 'Usuário removido'}</td>
          <td>{item.orderId ? `#${item.orderNumber ?? item.orderCode ?? item.orderId.slice(0, 8)}` : '—'}</td>
          <td className="max-w-xs truncate" title={item.reason ?? undefined}>{item.reason || '—'}</td>
          <td className="whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
        </tr>)}
      </DataTable>}
    {pages > 1 && <div className="mt-3 flex items-center justify-end gap-2">
      <button type="button" disabled={page <= 1 || loading} onClick={() => void load(page - 1)} className={secondaryButtonClass}>‹ Anterior</button>
      <button type="button" disabled={page >= pages || loading} onClick={() => void load(page + 1)} className={secondaryButtonClass}>Próxima ›</button>
    </div>}
  </AppShell>;
}
