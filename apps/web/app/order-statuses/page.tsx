'use client';

import { OrderStatusesSection } from '../../components/settings-sections';
import { AppShell, buttonClass, Notice } from '../../components/app-shell';
import { PageHeader } from '../../components/ui';
import { useSettings } from '../../lib/use-settings';

export default function OrderStatusesPage() {
  const { draft, canEdit, notice, setNotice, saving, isDirty, patch, save } = useSettings();
  const items = draft?.orderStatuses.items ?? [];

  async function submit() {
    if (items.some(item => !item.title.trim())) { setNotice({ text: 'Todos os status precisam de um título.', kind: 'error' }); return; }
    await save('orderStatuses', 'Status de pedido salvos.');
  }

  return <AppShell title="Status de pedido personalizado">
    <PageHeader title="Status de pedido personalizado" subtitle="Escolha quais etapas aparecem no acompanhamento dos pedidos e renomeie os títulos exibidos. A chave interna de cada status não muda."
      actions={<button type="button" onClick={() => void submit()} disabled={!canEdit || saving || !draft || !isDirty('orderStatuses')} className={buttonClass}>{saving ? 'Salvando…' : 'Salvar'}</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {draft && !canEdit && <Notice message="Seu perfil pode apenas consultar; somente administradores e gerentes podem alterar os status." />}
    {draft ? <OrderStatusesSection value={draft.orderStatuses} disabled={!canEdit || saving} onChange={change => patch('orderStatuses', change)} /> : <p className="text-sm text-slate-500">Carregando…</p>}
  </AppShell>;
}
