'use client';

import { AppShell, buttonClass, inputClass, Notice, panelClass } from '../../components/app-shell';
import { Badge, DataTable, PageHeader, Toggle } from '../../components/ui';
import { useSettings } from '../../lib/use-settings';

export default function OrderStatusesPage() {
  const { draft, canEdit, notice, setNotice, saving, isDirty, patch, save } = useSettings();
  const items = draft?.orderStatuses.items ?? [];
  const disabled = !canEdit || saving;
  const update = (key: string, change: Partial<(typeof items)[number]>) => patch('orderStatuses', { items: items.map(item => (item.key === key ? { ...item, ...change } : item)) });

  async function submit() {
    if (items.some(item => !item.title.trim())) { setNotice({ text: 'Todos os status precisam de um título.', kind: 'error' }); return; }
    await save('orderStatuses', 'Status de pedido salvos.');
  }

  return <AppShell title="Status de pedido personalizado">
    <PageHeader title="Status de pedido personalizado" subtitle="Escolha quais etapas aparecem no acompanhamento dos pedidos e renomeie os títulos exibidos. A chave interna de cada status não muda."
      actions={<button type="button" onClick={() => void submit()} disabled={!canEdit || saving || !draft || !isDirty('orderStatuses')} className={buttonClass}>{saving ? 'Salvando…' : 'Salvar'}</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {draft && !canEdit && <Notice message="Seu perfil pode apenas consultar; somente administradores e gerentes podem alterar os status." />}
    <section className={`${panelClass} mb-4 text-sm text-slate-600`}>Status inativos são pulados no acompanhamento. Alterações de título e ativação são guardadas aqui; o fluxo interno do pedido (aceite, preparo, entrega) não é modificado.</section>
    {!draft ? <p className="text-sm text-slate-500">Carregando…</p> : <DataTable columns={[{ label: 'Ativo', className: 'w-48' }, { label: 'Título exibido' }, { label: 'Chave interna', className: 'w-56' }]} footer={`${items.filter(item => item.active).length} de ${items.length} ativos`}>
      {items.map(item => <tr key={item.key}>
        <td><Toggle label={item.active ? 'Ativo' : 'Inativo'} checked={item.active} disabled={disabled} onChange={active => update(item.key, { active })} /></td>
        <td><label className="sr-only" htmlFor={`status-${item.key}`}>Título do status {item.key}</label><input id={`status-${item.key}`} value={item.title} maxLength={40} disabled={disabled} onChange={event => update(item.key, { title: event.target.value })} className={`${inputClass} mt-0`} aria-invalid={!item.title.trim()} /></td>
        <td><Badge>{item.key}</Badge></td>
      </tr>)}
    </DataTable>}
  </AppShell>;
}
