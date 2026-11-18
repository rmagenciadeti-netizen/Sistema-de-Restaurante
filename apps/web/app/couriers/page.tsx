'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import type { Courier, DeleteResult } from '../../lib/types-registry';

const emptyForm = { name: '', phone: '', payment: '', active: true };

export default function CouriersPage() {
  const [items, setItems] = useState<Courier[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<Courier | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string } = {}) {
    const params = new URLSearchParams();
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try { setItems((await api<ListResponse<Courier>>(`/couriers?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar entregadores'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(courier: Courier | 'new') {
    setNotice(null); setEditing(courier);
    setForm(courier === 'new' ? emptyForm : { name: courier.name, phone: courier.phone ?? '', payment: courier.paymentPerDelivery == null ? '' : String(Number(courier.paymentPerDelivery)), active: courier.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ name: form.name, phone: form.phone || null, paymentPerDelivery: form.payment === '' ? null : Number(form.payment), active: form.active });
    try {
      if (editing === 'new') await api('/couriers', { method: 'POST', body }); else await api(`/couriers/${editing!.id}`, { method: 'PATCH', body });
      ok('Entregador salvo.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar entregador'); } finally { setSaving(false); }
  }
  async function toggle(courier: Courier) {
    try { await api(`/couriers/${courier.id}`, { method: 'PATCH', body: JSON.stringify({ active: !courier.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar entregador'); }
  }
  async function remove(courier: Courier) {
    if (!window.confirm(`Excluir o entregador ${courier.name}? Se ele já tiver entregas, será apenas desativado.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/couriers/${courier.id}`, { method: 'DELETE' }), 'Entregador')); await load(); } catch (e) { fail(e, 'Erro ao excluir entregador'); }
  }

  return <AppShell title="Entregadores">
    <PageHeader title="Entregadores" subtitle="Cadastre quem faz as entregas para escolhê-los rapidamente em Entregas." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Novo entregador' : 'Editar entregador'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="Telefone/WhatsApp" type="tel" maxLength={30} placeholder="(11) 99999-0000" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Field label="Pagamento por entrega (R$)" type="number" min="0" max="9999.99" step="0.01" placeholder="Opcional" value={form.payment} onChange={e => setForm({ ...form, payment: e.target.value })} />
      </div>
      <Toggle label="Ativo" hint="Entregadores inativos não aparecem na escolha de novas entregas." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome ou telefone" />
    {loaded && items.length === 0 ? <EmptyState icon="🛵" title="Não há registros" hint="Adicione o primeiro entregador para escolhê-lo nas entregas." /> :
      <DataTable columns={[{ label: 'Nome' }, { label: 'Telefone' }, { label: 'Pagamento/entrega' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(courier => <tr key={courier.id}>
          <td className="font-medium text-slate-900">{courier.name}</td><td>{courier.phone || '—'}</td><td>{courier.paymentPerDelivery == null ? '—' : formatMoney(courier.paymentPerDelivery)}</td><td><ActiveBadge active={courier.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(courier)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(courier)}>{courier.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(courier)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
