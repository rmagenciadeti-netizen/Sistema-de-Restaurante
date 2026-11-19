'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import type { Courier, DeleteResult } from '../../lib/types-registry';

const emptyForm = { name: '', phone: '', payment: '', commission: '', active: true };
type Report = { courier: { name: string }; deliveries: number; averageMinutes: number | null; deliveryFees: number; totalOwed: number; items: { id: string; order: string; address: string | null; deliveredAt: string | null; minutes: number | null; deliveryFee: string | number; payout: string | number | null }[]; note: string };

export default function CouriersPage() {
  const [items, setItems] = useState<Courier[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<Courier | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [report, setReport] = useState<Report | null>(null);
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
    setForm(courier === 'new' ? emptyForm : { name: courier.name, phone: courier.phone ?? '', payment: courier.paymentPerDelivery == null ? '' : String(Number(courier.paymentPerDelivery)), commission: courier.commissionPercent == null ? '' : String(Number(courier.commissionPercent)), active: courier.active });
  }
  async function showReport(courier: Courier) {
    try { setReport(await api<Report>(`/couriers/${courier.id}/report`)); setNotice(null); } catch (e) { fail(e, 'Erro ao gerar o relatório do entregador'); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ name: form.name, phone: form.phone || null, paymentPerDelivery: form.payment === '' ? null : Number(form.payment), commissionPercent: form.commission === '' ? null : Number(form.commission), active: form.active });
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
    {report && <section className="mb-6 rounded-2xl border border-brand-500/40 bg-white p-5 text-slate-900 shadow-sm" aria-label="Relatório do entregador">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">Relatório de {report.courier.name} · últimos 30 dias</h2><button type="button" className={secondaryButtonClass} onClick={() => setReport(null)}>Fechar</button></div>
      <p className="mt-2 text-sm">{report.deliveries} entrega(s) · tempo médio {report.averageMinutes === null ? '—' : `${report.averageMinutes} min`} · taxas de entrega {formatMoney(report.deliveryFees)} · <strong>a pagar {formatMoney(report.totalOwed)}</strong></p>
      {report.items.length > 0 && <DataTable columns={[{ label: 'Pedido' }, { label: 'Entregue em' }, { label: 'Tempo' }, { label: 'Taxa' }, { label: 'Valor devido' }]}>{report.items.map(item => <tr key={item.id}><td>{item.order}</td><td>{item.deliveredAt ? new Date(item.deliveredAt).toLocaleString('pt-BR') : '—'}</td><td>{item.minutes === null ? '—' : `${item.minutes} min`}</td><td>{formatMoney(item.deliveryFee)}</td><td>{item.payout === null ? '—' : formatMoney(item.payout)}</td></tr>)}</DataTable>}
      <p className="mt-2 text-xs text-slate-500">{report.note}</p>
    </section>}
    {editing && <FormCard title={editing === 'new' ? 'Novo entregador' : 'Editar entregador'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="Telefone/WhatsApp" type="tel" maxLength={30} placeholder="(11) 99999-0000" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Field label="Pagamento por entrega (R$)" type="number" min="0" max="9999.99" step="0.01" placeholder="Opcional" value={form.payment} onChange={e => setForm({ ...form, payment: e.target.value })} />
        <Field label="Comissão sobre a taxa de entrega (%)" type="number" min="0" max="100" step="0.01" placeholder="Opcional" value={form.commission} onChange={e => setForm({ ...form, commission: e.target.value })} />
      </div>
      <Toggle label="Ativo" hint="Entregadores inativos não aparecem na escolha de novas entregas." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome ou telefone" />
    {loaded && items.length === 0 ? <EmptyState icon="🛵" title="Não há registros" hint="Adicione o primeiro entregador para escolhê-lo nas entregas." /> :
      <DataTable columns={[{ label: 'Nome' }, { label: 'Telefone' }, { label: 'Pagamento/entrega' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(courier => <tr key={courier.id}>
          <td className="font-medium text-slate-900">{courier.name}</td><td>{courier.phone || '—'}</td><td>{courier.paymentPerDelivery == null ? '—' : formatMoney(courier.paymentPerDelivery)}{courier.commissionPercent != null && Number(courier.commissionPercent) > 0 ? ` + ${Number(courier.commissionPercent)}% da taxa` : ''}</td><td><ActiveBadge active={courier.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => void showReport(courier)}>Relatório</button><button className={secondaryButtonClass} onClick={() => open(courier)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(courier)}>{courier.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(courier)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
