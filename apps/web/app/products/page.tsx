'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatMoney, ListResponse, ProductCategory, Sector } from '../../lib/api';
import type { CatalogProduct as Product, TaxRuleOption } from '../../lib/types-catalog';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, Select, secondaryButtonClass } from '../../components/app-shell';
import { Badge, Tabs, textareaClass, Toggle } from '../../components/ui';

const emptyForm = {
  name: '', code: '', price: '', cost: '', sectorId: '', categoryId: '', barcode: '', favorite: false, soldByWeight: false, active: true,
  sendToScale: false, scaleCode: '', scaleDepartment: '', shelfLifeDays: '', scaleNotes: '', ncm: '', cest: '', taxRuleId: '',
};
type FormTab = 'data' | 'scale' | 'tax';
const formTabs: { key: FormTab; label: string }[] = [{ key: 'data', label: 'Dados' }, { key: 'scale', label: 'Balança' }, { key: 'tax', label: 'Fiscal' }];
const optionalInt = (value: string) => (value.trim() === '' ? null : Number(value));

export default function ProductsPage() {
  const [items, setItems] = useState<Product[]>([]); const [sectors, setSectors] = useState<Sector[]>([]); const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [prices, setPrices] = useState<Record<string, string>>({}); const [savingPrices, setSavingPrices] = useState(false);
  const [percentage, setPercentage] = useState(''); const [priceDirection, setPriceDirection] = useState<'increase' | 'decrease'>('increase');
  const [editingId, setEditingId] = useState<string | null>(null); const [formTab, setFormTab] = useState<FormTab>('data'); const [taxRules, setTaxRules] = useState<TaxRuleOption[]>([]);
  async function load(nextPage = page) { try { const [products, production, categoryList] = await Promise.all([api<ListResponse<Product>>(`/products?page=${nextPage}&pageSize=100`), api<ListResponse<Sector>>('/production/sectors'), api<ListResponse<ProductCategory>>('/products/categories')]); setItems(products.items); setTotal(products.total); setPage(nextPage); setPrices({}); setSectors(production.items); setCategories(categoryList.items); api<ListResponse<TaxRuleOption>>('/tax-rules').then(rules => setTaxRules(rules.items.filter(rule => rule.active !== false))).catch(() => setTaxRules([])); return true; } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao carregar catálogo'); return false; } }
  useEffect(() => { void load(); }, []);
  function startEdit(item: Product) {
    setForm({
      name: item.name, code: item.code ?? '', price: String(item.price), cost: item.cost == null ? '' : String(item.cost), sectorId: item.sector?.id ?? '', categoryId: item.category?.id ?? '',
      barcode: item.barcode ?? '', favorite: Boolean(item.favorite), soldByWeight: Boolean(item.soldByWeight), active: item.active, sendToScale: Boolean(item.sendToScale),
      scaleCode: item.scaleCode == null ? '' : String(item.scaleCode), scaleDepartment: item.scaleDepartment == null ? '' : String(item.scaleDepartment), shelfLifeDays: item.shelfLifeDays == null ? '' : String(item.shelfLifeDays),
      scaleNotes: item.scaleNotes ?? '', ncm: item.ncm ?? '', cest: item.cest ?? '', taxRuleId: item.taxRuleId ?? '',
    });
    setEditingId(item.id); setFormTab('data'); setMessage('');
    document.getElementById('product-form')?.scrollIntoView?.({ behavior: 'smooth' });
  }
  function cancelEdit() { setForm(emptyForm); setEditingId(null); setFormTab('data'); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage('');
    const ncm = form.ncm.replace(/\D/g, ''); const cest = form.cest.replace(/\D/g, '');
    if (form.sendToScale && !form.scaleCode.trim()) { setFormTab('scale'); setMessage('Informe o código da balança para enviar o produto à balança.'); return; }
    if (ncm && ncm.length !== 8) { setFormTab('tax'); setMessage('O NCM deve ter 8 dígitos.'); return; }
    if (cest && cest.length !== 7) { setFormTab('tax'); setMessage('O CEST deve ter 7 dígitos.'); return; }
    const editing = editingId !== null;
    const body = {
      name: form.name, code: form.code || (editing ? null : undefined), price: Number(form.price), cost: editing ? (form.cost === '' ? null : Number(form.cost)) : Number(form.cost || 0),
      sectorId: form.sectorId || (editing ? null : undefined), categoryId: form.categoryId || (editing ? null : undefined), active: form.active,
      barcode: form.barcode.trim() || null, favorite: form.favorite, soldByWeight: form.soldByWeight, sendToScale: form.sendToScale,
      scaleCode: optionalInt(form.scaleCode), scaleDepartment: optionalInt(form.scaleDepartment), shelfLifeDays: optionalInt(form.shelfLifeDays), scaleNotes: form.scaleNotes.trim() || null,
      ncm: ncm || null, cest: cest || null, taxRuleId: form.taxRuleId || null,
    };
    try {
      await api(editing ? `/products/${editingId}` : '/products', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      cancelEdit(); setMessage(editing ? 'Produto atualizado.' : 'Produto cadastrado.'); await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : editing ? 'Erro ao atualizar produto' : 'Erro ao cadastrar produto'); }
  }
  async function changeCategory(item: Product, categoryId: string) {
    setMessage('');
    try { await api(`/products/${item.id}`, { method: 'PATCH', body: JSON.stringify({ categoryId: categoryId || null }) }); if (await load()) setMessage('Categoria atualizada.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao atualizar categoria'); }
  }
  function selectPrice(item: Product, checked: boolean) {
    setPrices(current => {
      const next = { ...current };
      if (checked) next[item.id] = String(item.price);
      else delete next[item.id];
      return next;
    });
  }
  function previewPercentage() {
    const text = percentage.trim().replace(',', '.');
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text) || Number(text) > 100) {
      setMessage('Informe um percentual entre 0 e 100, com até duas casas decimais.'); return;
    }
    const [whole, fraction = ''] = text.split('.');
    const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const next: Record<string, string> = {};
    for (const item of items.filter(product => Object.hasOwn(prices, product.id))) {
      const [units, cents = ''] = String(item.price).split('.');
      const original = Number(units) * 100 + Number(cents.padEnd(2, '0'));
      const factor = 10000 + (priceDirection === 'increase' ? basisPoints : -basisPoints);
      const result = Math.floor(original / 10000) * factor + Math.round((original % 10000) * factor / 10000);
      if (result > 999999999999) { setMessage('O ajuste ultrapassa o preço máximo permitido.'); return; }
      next[item.id] = `${Math.floor(result / 100)}.${String(result % 100).padStart(2, '0')}`;
    }
    setPrices(next); setMessage('');
  }
  async function savePrices() {
    const selected = items.filter(item => Object.hasOwn(prices, item.id));
    const changes = selected.map(item => ({ id: item.id, expectedPrice: String(item.price), price: prices[item.id].trim().replace(',', '.') }));
    if (!changes.length || changes.some(item => !/^\d{1,10}(?:\.\d{1,2})?$/.test(item.price))) {
      setMessage('Informe preços válidos, não negativos, com até duas casas decimais.'); return;
    }
    if (!window.confirm(`Confirmar a alteração de preços de ${changes.length} produto(s)?`)) return;
    setSavingPrices(true); setMessage('');
    try {
      await api('/products/prices/bulk', { method: 'PATCH', body: JSON.stringify({ items: changes }) });
      if (await load()) setMessage('Preços atualizados.');
      else setMessage('Preços atualizados, mas não foi possível atualizar o catálogo. Tente atualizar a lista.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao atualizar preços'); }
    finally { setSavingPrices(false); }
  }
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const visibleItems = items.filter(item => `${item.name} ${item.code ?? ''} ${item.barcode ?? ''} ${item.sector?.name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term));
  const selectedItems = items.filter(item => Object.hasOwn(prices, item.id));
  return <AppShell title="Produtos e produção">
    {message && <Notice message={message} kind={message.includes('cadastrado') || message === 'Produto atualizado.' || message === 'Preços atualizados.' || message === 'Categoria atualizada.' ? 'success' : 'error'} />}
    <section id="product-form" className={`${panelClass} mb-6`}>
      <h2 className="mb-4 text-lg font-semibold">{editingId ? 'Editar produto' : 'Novo produto'}</h2>
      <Tabs tabs={formTabs} value={formTab} onChange={setFormTab} label="Seções do produto" />
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {formTab === 'data' && <>
          <Field label="Nome" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Field label="Código" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
          <Field label="Código de barras" inputMode="numeric" maxLength={40} value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })} />
          <Field label={form.soldByWeight ? 'Preço por kg (R$)' : 'Preço de venda (R$)'} type="number" min="0" step="0.01" required value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} />
          <Field label="Custo (R$)" type="number" min="0" step="0.01" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} />
          <Select label="Setor de produção" value={form.sectorId} onChange={e => setForm({ ...form, sectorId: e.target.value })}><option value="">Sem setor</option>{sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</Select>
          <Select label="Categoria" value={form.categoryId} onChange={e => setForm({ ...form, categoryId: e.target.value })}><option value="">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Select>
          <div className="flex flex-col justify-end gap-2">
            <Check label="Favorito" checked={form.favorite} onChange={e => setForm({ ...form, favorite: e.target.checked })} />
            <Check label="Vendido por peso (preço por kg)" checked={form.soldByWeight} onChange={e => setForm({ ...form, soldByWeight: e.target.checked })} />
            {editingId && <Check label="Produto ativo" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />}
          </div>
        </>}
        {formTab === 'scale' && <>
          <div className="md:col-span-2 xl:col-span-3"><Toggle label="Enviar para balança" hint="Inclui o produto no arquivo de itens gerado em Arquivo para balança. Exige o código da balança." checked={form.sendToScale} onChange={sendToScale => setForm({ ...form, sendToScale })} /></div>
          <Field label="Código da balança (PLU)" type="number" min="1" max="9999999" value={form.scaleCode} onChange={e => setForm({ ...form, scaleCode: e.target.value })} />
          <Field label="Departamento" type="number" min="0" max="99" value={form.scaleDepartment} onChange={e => setForm({ ...form, scaleDepartment: e.target.value })} />
          <Field label="Validade (dias)" type="number" min="0" max="999" value={form.shelfLifeDays} onChange={e => setForm({ ...form, shelfLifeDays: e.target.value })} />
          <label className="block text-sm font-medium text-slate-700 md:col-span-2 xl:col-span-3">Observações da balança<textarea className={textareaClass} rows={2} maxLength={500} value={form.scaleNotes} onChange={e => setForm({ ...form, scaleNotes: e.target.value })} /></label>
          <p className="text-xs text-slate-500 md:col-span-2 xl:col-span-3">Produtos de balança normalmente são vendidos por peso. O código da balança é único em todo o restaurante. <Link href="/scale-file" className="font-semibold text-brand-700 underline">Gerar arquivo para a balança</Link></p>
        </>}
        {formTab === 'tax' && <>
          <Field label="NCM" inputMode="numeric" placeholder="8 dígitos" maxLength={10} value={form.ncm} onChange={e => setForm({ ...form, ncm: e.target.value })} />
          <Field label="CEST" inputMode="numeric" placeholder="7 dígitos" maxLength={9} value={form.cest} onChange={e => setForm({ ...form, cest: e.target.value })} />
          <Select label="Regra tributária" value={form.taxRuleId} onChange={e => setForm({ ...form, taxRuleId: e.target.value })}><option value="">Sem regra tributária</option>{taxRules.map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</Select>
          {taxRules.length === 0 && <p className="text-xs text-slate-500 md:col-span-2 xl:col-span-3">Nenhuma regra tributária disponível. Os dados fiscais ficam apenas cadastrados; a emissão depende do provedor fiscal configurado.</p>}
        </>}
        <div className="flex items-end gap-2 md:col-span-2 xl:col-span-3"><button className={buttonClass}>{editingId ? 'Salvar alterações' : 'Adicionar produto'}</button>{editingId && <button type="button" className={secondaryButtonClass} onClick={cancelEdit}>Cancelar edição</button>}<Link href="/categories" className={secondaryButtonClass}>Categorias</Link></div>
      </form>
    </section>
    <section className={panelClass}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Seu cardápio</p><h2 className="mt-1 text-lg font-semibold">Catálogo ({visibleItems.length} nesta página; {total} no total)</h2></div><div className="w-full sm:max-w-xs"><Field label="Pesquisar nesta página" type="search" placeholder="Nome, código ou setor" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600"><tr><th className="p-3">Ajustar</th><th className="p-3">Produto</th><th className="p-3">Código</th><th className="p-3">Categoria</th><th className="p-3">Setor</th><th className="p-3">Preço</th><th className="p-3">Situação</th><th className="p-3">Estoque</th><th className="p-3">Ações</th></tr></thead>
        <tbody>{visibleItems.map(item => <tr key={item.id} className="border-b border-slate-200">
          <td className="p-3"><input type="checkbox" aria-label={`Selecionar ${item.name} para ajuste de preço`} checked={Object.hasOwn(prices, item.id)} disabled={savingPrices} onChange={event => selectPrice(item, event.target.checked)} /></td>
          <td className="p-3 font-semibold">{item.favorite && <span aria-label="Favorito" title="Favorito" className="mr-1 text-brand-600">★</span>}{item.name}{item.soldByWeight && <> <Badge tone="blue">Por kg</Badge></>}{item.sendToScale && <> <Badge tone="gold">Balança {item.scaleCode}</Badge></>}</td><td className="p-3">{item.code || '—'}</td>
          <td className="p-3"><select aria-label={`Categoria de ${item.name}`} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5" value={item.category?.id ?? ''} disabled={savingPrices || selectedItems.length > 0} onChange={event => void changeCategory(item, event.target.value)}><option value="">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></td>
          <td className="p-3">{item.sector?.name || '—'}</td><td className="p-3 font-semibold">{formatMoney(item.price)}{item.soldByWeight ? '/kg' : ''}</td><td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${item.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{item.active ? 'Ativo' : 'Inativo'}</span></td><td className="p-3">{item.active && <Link href={`/inventory?productId=${encodeURIComponent(item.id)}#ficha-tecnica`} className={`${secondaryButtonClass} inline-block whitespace-nowrap`}>Ficha técnica</Link>}</td><td className="p-3"><button type="button" className={secondaryButtonClass} disabled={savingPrices} onClick={() => startEdit(item)}>Editar</button></td>
        </tr>)}</tbody>
      </table></div>
      {visibleItems.length === 0 && <p className="p-4 text-sm text-slate-500">{items.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado.'}</p>}
      <div className="mt-4 flex items-center gap-3"><button type="button" className={secondaryButtonClass} disabled={page === 1 || savingPrices} onClick={() => void load(page - 1)}>Anterior</button><span className="text-sm">Página {page}</span><button type="button" className={secondaryButtonClass} disabled={page * 100 >= total || savingPrices} onClick={() => void load(page + 1)}>Próxima</button><button type="button" className={secondaryButtonClass} disabled={savingPrices} onClick={() => void load()}>Atualizar lista</button></div>
    </section>
    {selectedItems.length > 0 && <section className={`${panelClass} mt-6`}>
      <h2 className="text-lg font-semibold">Revisar preços ({selectedItems.length})</h2>
      <p className="mt-1 text-sm text-slate-500">Confira os valores antes de confirmar. Alterar a página ou atualizar a lista descarta a seleção.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm text-slate-700">Ajuste percentual<select className="mt-1 block rounded-xl border border-slate-300 bg-white px-3 py-2.5" value={priceDirection} disabled={savingPrices} onChange={event => setPriceDirection(event.target.value === 'decrease' ? 'decrease' : 'increase')}><option value="increase">Aumentar</option><option value="decrease">Reduzir</option></select></label><div className="w-40"><Field label="Percentual (%)" inputMode="decimal" value={percentage} disabled={savingPrices} onChange={event => setPercentage(event.target.value)} /></div><button type="button" className={secondaryButtonClass} disabled={savingPrices} onClick={previewPercentage}>Calcular prévia</button></div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{selectedItems.map(item => <div key={item.id} className="rounded-lg border border-slate-200 p-3"><p className="font-semibold">{item.name}</p><p className="mb-2 text-sm">Preço atual: {formatMoney(item.price)}</p><Field label={`Novo preço de ${item.name} (R$)`} inputMode="decimal" value={prices[item.id]} disabled={savingPrices} onChange={event => setPrices(current => ({ ...current, [item.id]: event.target.value }))} /></div>)}</div>
      <button type="button" className={`${buttonClass} mt-4`} disabled={savingPrices} onClick={() => void savePrices()}>{savingPrices ? 'Salvando...' : 'Confirmar preços'}</button>
    </section>}
  </AppShell>;
}
