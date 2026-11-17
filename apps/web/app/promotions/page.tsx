'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney, ListResponse, toIso } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import type { CatalogProduct, Promotion, PromotionStatus } from '../../lib/types-catalog';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, dangerButtonClass, EmptyState, PageHeader, Tabs } from '../../components/ui';

type StatusFilter = 'todas' | 'ativas' | 'inativas' | 'expiradas';
const filters: { key: StatusFilter; label: string }[] = [{ key: 'todas', label: 'Todas' }, { key: 'ativas', label: 'Ativas' }, { key: 'inativas', label: 'Inativas' }, { key: 'expiradas', label: 'Expiradas' }];
const statusView: Record<PromotionStatus, { label: string; tone: 'green' | 'blue' | 'neutral' | 'red' }> = {
  ACTIVE: { label: 'Vigente', tone: 'green' }, SCHEDULED: { label: 'Agendada', tone: 'blue' }, INACTIVE: { label: 'Inativa', tone: 'neutral' }, EXPIRED: { label: 'Expirada', tone: 'red' },
};
const emptyForm = { name: '', type: 'PERCENT' as 'PERCENT' | 'FIXED', value: '', startsAt: '', endsAt: '', active: true, productIds: [] as string[] };

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function PromotionsPage() {
  const [items, setItems] = useState<Promotion[]>([]);
  const [status, setStatus] = useState<StatusFilter>('todas');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function loadPromotions(nextStatus = status, nextQuery = query) {
    try {
      const params = new URLSearchParams({ status: nextStatus });
      if (nextQuery.trim()) params.set('q', nextQuery.trim());
      setItems((await api<ListResponse<Promotion>>(`/promotions?${params}`)).items);
    } catch (e) { fail(e, 'Erro ao carregar promoções'); }
  }
  async function loadProducts() {
    try {
      const all: CatalogProduct[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const result = await api<ListResponse<CatalogProduct>>(`/products?page=${page}&pageSize=100`);
        all.push(...result.items);
        if (all.length >= result.total) break;
      }
      setProducts(all.filter(product => product.active));
    } catch (e) { fail(e, 'Erro ao carregar produtos'); }
  }
  useAutoLoad(async () => { await Promise.all([loadPromotions(), loadProducts()]); });

  function openNew() {
    const now = new Date();
    setForm({ ...emptyForm, startsAt: toLocalInput(now.toISOString()) }); setEditingId(null); setProductSearch(''); setFormOpen(true); setNotice(null);
  }
  function openEdit(item: Promotion) {
    setForm({ name: item.name, type: item.type, value: String(item.value), startsAt: toLocalInput(item.startsAt), endsAt: toLocalInput(item.endsAt), active: item.active, productIds: item.products.map(product => product.id) });
    setEditingId(item.id); setProductSearch(''); setFormOpen(true); setNotice(null);
  }
  function toggleProduct(id: string, checked: boolean) {
    setForm(current => ({ ...current, productIds: checked ? [...current.productIds.filter(productId => productId !== id), id] : current.productIds.filter(productId => productId !== id) }));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const value = Number(form.value.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) { setNotice({ text: 'Informe um desconto maior que zero.', kind: 'error' }); return; }
    if (form.type === 'PERCENT' && value > 100) { setNotice({ text: 'O desconto percentual não pode passar de 100%.', kind: 'error' }); return; }
    if (form.productIds.length === 0) { setNotice({ text: 'Escolha ao menos um produto para a promoção.', kind: 'error' }); return; }
    const body = { name: form.name.trim(), type: form.type, value, startsAt: toIso(form.startsAt), endsAt: form.endsAt ? toIso(form.endsAt) : null, active: form.active, productIds: form.productIds };
    setSaving(true);
    try {
      await api(editingId ? `/promotions/${editingId}` : '/promotions', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setFormOpen(false); setEditingId(null);
      setNotice({ text: editingId ? 'Promoção atualizada.' : 'Promoção criada.', kind: 'success' });
      await loadPromotions();
    } catch (e) { fail(e, 'Erro ao salvar promoção'); }
    finally { setSaving(false); }
  }
  async function toggleActive(item: Promotion) {
    setNotice(null);
    try { await api(`/promotions/${item.id}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) }); await loadPromotions(); } catch (e) { fail(e, 'Erro ao atualizar promoção'); }
  }
  async function remove(item: Promotion) {
    if (!window.confirm(`Excluir a promoção “${item.name}”?`)) return;
    setNotice(null);
    try { await api(`/promotions/${item.id}`, { method: 'DELETE' }); setNotice({ text: 'Promoção excluída.', kind: 'success' }); await loadPromotions(); } catch (e) { fail(e, 'Erro ao excluir promoção'); }
  }
  function changeStatus(next: StatusFilter) { setStatus(next); void loadPromotions(next, query); }

  const term = productSearch.trim().toLocaleLowerCase('pt-BR');
  const pickable = products.filter(product => form.productIds.includes(product.id) || `${product.name} ${product.code ?? ''}`.toLocaleLowerCase('pt-BR').includes(term));

  return <AppShell title="Promoções">
    <PageHeader title="Promoções" subtitle="Descontos por produto com vigência. O preço promocional aparece no cardápio das mesas e é aplicado automaticamente ao criar pedidos."
      actions={<button type="button" className={buttonClass} onClick={openNew}>Nova promoção</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {formOpen && <section className={`${panelClass} mb-6`}>
      <h2 className="mb-4 text-lg font-semibold">{editingId ? 'Editar promoção' : 'Nova promoção'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Field label="Nome" required minLength={2} maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Select label="Tipo de desconto" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as 'PERCENT' | 'FIXED' })}><option value="PERCENT">Percentual (%)</option><option value="FIXED">Valor fixo (R$)</option></Select>
        <Field label={form.type === 'PERCENT' ? 'Desconto (%)' : 'Desconto (R$)'} inputMode="decimal" required value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />
        <Field label="Início" type="datetime-local" required value={form.startsAt} onChange={e => setForm({ ...form, startsAt: e.target.value })} />
        <Field label="Fim (opcional)" type="datetime-local" value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} />
        <div className="flex items-end"><Check label="Promoção ativa" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /></div>
        <div className="md:col-span-2 xl:col-span-3">
          <Field label="Buscar produtos" type="search" placeholder="Nome ou código" value={productSearch} onChange={e => setProductSearch(e.target.value)} />
          <p className="mt-2 text-xs text-slate-500">{form.productIds.length} produto(s) selecionado(s). O desconto vale para o preço de cada produto escolhido; se houver mais de uma promoção, vale a de menor preço.</p>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200 p-2" role="group" aria-label="Produtos da promoção">
            {pickable.length === 0 ? <p className="p-2 text-sm text-slate-500">Nenhum produto encontrado.</p> : pickable.map(product => <div key={product.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
              <Check label={product.name} checked={form.productIds.includes(product.id)} onChange={e => toggleProduct(product.id, e.target.checked)} /><span className="text-xs text-slate-500">{formatMoney(product.price)}</span>
            </div>)}
          </div>
        </div>
        <div className="flex gap-2 md:col-span-2 xl:col-span-3"><button className={buttonClass} disabled={saving}>{saving ? 'Salvando...' : 'Salvar promoção'}</button><button type="button" className={secondaryButtonClass} onClick={() => setFormOpen(false)}>Cancelar</button></div>
      </form>
    </section>}
    <Tabs tabs={filters} value={status} onChange={changeStatus} label="Situação das promoções" />
    <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void loadPromotions(); }}>
      <div className="w-full sm:max-w-xs"><Field label="Buscar por nome" type="search" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <button className={secondaryButtonClass}>Buscar</button>
    </form>
    {items.length === 0 ? <EmptyState icon="🏷️" title="Nenhuma promoção encontrada" hint="Crie uma promoção para aplicar descontos automáticos em produtos." />
      : <DataTable columns={[{ label: 'Promoção' }, { label: 'Desconto' }, { label: 'Vigência' }, { label: 'Produtos' }, { label: 'Situação' }, { label: 'Ações' }]} footer={`${items.length} promoção(ões)`}>
        {items.map(item => <tr key={item.id}>
          <td className="font-semibold">{item.name}</td>
          <td>{item.type === 'PERCENT' ? `${Number(item.value)}%` : formatMoney(item.value)}</td>
          <td className="text-xs">{formatDateTime(item.startsAt)}<br />até {item.endsAt ? formatDateTime(item.endsAt) : 'sem fim'}</td>
          <td className="max-w-xs text-xs text-slate-600">{item.products.length === 0 ? '—' : item.products.slice(0, 3).map(product => product.name).join(', ') + (item.products.length > 3 ? ` e mais ${item.products.length - 3}` : '')}</td>
          <td><Badge tone={statusView[item.status].tone}>{statusView[item.status].label}</Badge></td>
          <td><div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => openEdit(item)}>Editar</button>
            {item.status !== 'EXPIRED' && <button type="button" className={secondaryButtonClass} onClick={() => void toggleActive(item)}>{item.active ? 'Desativar' : 'Ativar'}</button>}
            <button type="button" className={dangerButtonClass} onClick={() => void remove(item)}>Excluir</button>
          </div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
