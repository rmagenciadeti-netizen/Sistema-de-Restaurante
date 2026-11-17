'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage, ListResponse, Product } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, Select, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import type { DeleteResult, TaxRule, TaxRuleProduct } from '../../lib/types-registry';

type TabKey = 'rules' | 'icms' | 'pis' | 'products';
const tabs: { key: TabKey; label: string }[] = [{ key: 'rules', label: 'Regras' }, { key: 'icms', label: 'Alíquotas ICMS e redução' }, { key: 'pis', label: 'PIS/COFINS' }, { key: 'products', label: 'Produtos vinculados' }];
const originLabels = ['0 — Nacional', '1 — Estrangeira (importação direta)', '2 — Estrangeira (mercado interno)', '3 — Nacional (importação entre 40% e 70%)', '4 — Nacional (processos produtivos básicos)', '5 — Nacional (importação até 40%)', '6 — Estrangeira (importação direta, sem similar)', '7 — Estrangeira (mercado interno, sem similar)', '8 — Nacional (importação acima de 70%)'];
const emptyForm = { name: '', ncm: '', cest: '', origin: '0', cfop: '', icmsCst: '', icmsRate: '', icmsReduction: '', pisCst: '', pisRate: '', cofinsCst: '', cofinsRate: '', active: true };
type CatalogProduct = Product & { taxRuleId?: string | null };

const text = (value?: string | number | null) => (value === null || value === undefined ? '' : String(value));
const percent = (value?: string | number | null) => (value === null || value === undefined || value === '' ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}%`);
const optionalRate = (value: string) => (value.trim() === '' ? null : Number(value.replace(',', '.')));

function TaxRulesContent() {
  const initialTab = useSearchParams().get('tab');
  const [items, setItems] = useState<TaxRule[]>([]);
  const [tab, setTab] = useState<TabKey>(initialTab === 'icms' || initialTab === 'pis' ? initialTab : 'rules');
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<TaxRule | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [ruleId, setRuleId] = useState('');
  const [linked, setLinked] = useState<TaxRuleProduct[]>([]);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [productQ, setProductQ] = useState('');
  const ok = (message: string) => setNotice({ text: message, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string } = {}) {
    const params = new URLSearchParams();
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try { setItems((await api<ListResponse<TaxRule>>(`/tax-rules?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar regras tributárias'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  async function loadLinked(id: string) {
    if (!id) { setLinked([]); return; }
    try { setLinked((await api<ListResponse<TaxRuleProduct>>(`/tax-rules/${id}/products`)).items); } catch (e) { fail(e, 'Erro ao carregar produtos vinculados'); }
  }
  async function loadCatalog() {
    try {
      const all: CatalogProduct[] = [];
      for (let page = 1; page <= 30; page += 1) {
        const result = await api<ListResponse<CatalogProduct>>(`/products?page=${page}&pageSize=100`);
        all.push(...result.items);
        if (all.length >= result.total || result.items.length === 0) break;
      }
      setCatalog(all); setCatalogLoaded(true);
    } catch (e) { fail(e, 'Erro ao carregar produtos'); }
  }
  function chooseTab(next: TabKey) {
    setTab(next); setNotice(null);
    if (next === 'products') { if (!ruleId && items[0]) { setRuleId(items[0].id); void loadLinked(items[0].id); } if (!catalogLoaded) void loadCatalog(); }
  }
  function chooseRule(id: string) { setRuleId(id); setPicked([]); void loadLinked(id); }

  function open(rule: TaxRule | 'new') {
    setNotice(null); setEditing(rule);
    setForm(rule === 'new' ? emptyForm : { name: rule.name, ncm: text(rule.ncm), cest: text(rule.cest), origin: String(rule.origin), cfop: text(rule.cfop), icmsCst: text(rule.icmsCst), icmsRate: text(rule.icmsRate), icmsReduction: text(rule.icmsReduction), pisCst: text(rule.pisCst), pisRate: text(rule.pisRate), cofinsCst: text(rule.cofinsCst), cofinsRate: text(rule.cofinsRate), active: rule.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ name: form.name, ncm: form.ncm || null, cest: form.cest || null, origin: Number(form.origin), cfop: form.cfop || null, icmsCst: form.icmsCst || null, icmsRate: optionalRate(form.icmsRate), icmsReduction: optionalRate(form.icmsReduction), pisCst: form.pisCst || null, pisRate: optionalRate(form.pisRate), cofinsCst: form.cofinsCst || null, cofinsRate: optionalRate(form.cofinsRate), active: form.active });
    try {
      if (editing === 'new') await api('/tax-rules', { method: 'POST', body }); else await api(`/tax-rules/${editing!.id}`, { method: 'PATCH', body });
      ok('Regra salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar regra'); } finally { setSaving(false); }
  }
  async function toggle(rule: TaxRule) {
    try { await api(`/tax-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ active: !rule.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar regra'); }
  }
  async function remove(rule: TaxRule) {
    if (!window.confirm(`Excluir a regra ${rule.name}? Se houver produtos vinculados, será apenas desativada.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/tax-rules/${rule.id}`, { method: 'DELETE' }), 'Regra')); await load(); } catch (e) { fail(e, 'Erro ao excluir regra'); }
  }
  async function assign() {
    try {
      const result = await api<{ updated: number }>(`/tax-rules/${ruleId}/assign`, { method: 'POST', body: JSON.stringify({ productIds: picked }) });
      ok(`${result.updated} produto(s) vinculado(s).`); setPicked([]); await Promise.all([loadLinked(ruleId), loadCatalog(), load()]);
    } catch (e) { fail(e, 'Erro ao vincular produtos'); }
  }
  async function unassign(productId: string) {
    try { await api(`/tax-rules/${ruleId}/unassign`, { method: 'POST', body: JSON.stringify({ productIds: [productId] }) }); await Promise.all([loadLinked(ruleId), loadCatalog(), load()]); } catch (e) { fail(e, 'Erro ao desvincular produto'); }
  }

  const rowActions = (rule: TaxRule) => <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(rule)}>Editar</button>{tab === 'rules' && <><button className={secondaryButtonClass} onClick={() => void toggle(rule)}>{rule.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(rule)}>Excluir</button></>}</div></td>;
  const empty = <EmptyState icon="🧾" title="Não há registros" hint="Cadastre uma regra tributária para vinculá-la aos produtos." />;
  const needle = productQ.trim().toLowerCase();
  const candidates = catalog.filter(product => product.taxRuleId !== ruleId && (!needle || product.name.toLowerCase().includes(needle) || (product.code ?? '').toLowerCase().includes(needle)));
  const ruleName = (id?: string | null) => items.find(rule => rule.id === id)?.name;

  return <AppShell title="Fiscal / Tributos">
    <PageHeader title="Fiscal / Tributos" subtitle="Regras tributárias por grupo de produtos (NCM, CFOP, CST e alíquotas)." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Esta tela apenas <strong>armazena os parâmetros</strong> que serão enviados ao provedor fiscal. O sistema não calcula nem transmite impostos: a emissão de documentos depende do provedor fiscal configurado em <Link href="/fiscal" className="font-semibold underline">Fiscal</Link> e da homologação junto à contabilidade.</p>
    <Tabs tabs={tabs} value={tab} onChange={chooseTab} label="Seções fiscais" />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Nova regra tributária' : 'Editar regra tributária'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Nome da regra" required minLength={2} maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="NCM (8 dígitos)" inputMode="numeric" maxLength={10} placeholder="22021000" value={form.ncm} onChange={e => setForm({ ...form, ncm: e.target.value })} />
        <Field label="CEST (7 dígitos)" inputMode="numeric" maxLength={9} placeholder="0300100" value={form.cest} onChange={e => setForm({ ...form, cest: e.target.value })} />
        <Select label="Origem da mercadoria" value={form.origin} onChange={e => setForm({ ...form, origin: e.target.value })}>{originLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</Select>
        <Field label="CFOP (4 dígitos)" inputMode="numeric" maxLength={4} placeholder="5102" value={form.cfop} onChange={e => setForm({ ...form, cfop: e.target.value })} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="CST/CSOSN do ICMS" inputMode="numeric" maxLength={3} placeholder="00" value={form.icmsCst} onChange={e => setForm({ ...form, icmsCst: e.target.value })} />
        <Field label="Alíquota do ICMS (%)" type="number" min="0" max="100" step="0.001" value={form.icmsRate} onChange={e => setForm({ ...form, icmsRate: e.target.value })} />
        <Field label="Redução da base do ICMS (%)" type="number" min="0" max="100" step="0.001" value={form.icmsReduction} onChange={e => setForm({ ...form, icmsReduction: e.target.value })} />
        <Field label="CST do PIS" inputMode="numeric" maxLength={3} value={form.pisCst} onChange={e => setForm({ ...form, pisCst: e.target.value })} />
        <Field label="Alíquota do PIS (%)" type="number" min="0" max="100" step="0.001" value={form.pisRate} onChange={e => setForm({ ...form, pisRate: e.target.value })} />
        <span className="hidden md:block" />
        <Field label="CST da COFINS" inputMode="numeric" maxLength={3} value={form.cofinsCst} onChange={e => setForm({ ...form, cofinsCst: e.target.value })} />
        <Field label="Alíquota da COFINS (%)" type="number" min="0" max="100" step="0.001" value={form.cofinsRate} onChange={e => setForm({ ...form, cofinsRate: e.target.value })} />
      </div>
      <Toggle label="Ativo" hint="Somente regras ativas aceitam novos produtos." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}

    {tab !== 'products' && <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome ou NCM" />}
    {tab === 'rules' && (loaded && items.length === 0 ? empty :
      <DataTable columns={[{ label: 'Regra' }, { label: 'NCM' }, { label: 'CEST' }, { label: 'CFOP' }, { label: 'Origem' }, { label: 'Produtos' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(rule => <tr key={rule.id}><td className="font-medium text-slate-900">{rule.name}</td><td>{rule.ncm || '—'}</td><td>{rule.cest || '—'}</td><td>{rule.cfop || '—'}</td><td>{rule.origin}</td><td>{rule._count?.products ?? 0}</td><td><ActiveBadge active={rule.active} /></td>{rowActions(rule)}</tr>)}
      </DataTable>)}
    {tab === 'icms' && (loaded && items.length === 0 ? empty :
      <DataTable columns={[{ label: 'Regra' }, { label: 'CST/CSOSN' }, { label: 'Alíquota ICMS' }, { label: 'Redução da base' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]}>
        {items.map(rule => <tr key={rule.id}><td className="font-medium text-slate-900">{rule.name}</td><td>{rule.icmsCst || '—'}</td><td>{percent(rule.icmsRate)}</td><td>{percent(rule.icmsReduction)}</td><td><ActiveBadge active={rule.active} /></td>{rowActions(rule)}</tr>)}
      </DataTable>)}
    {tab === 'pis' && (loaded && items.length === 0 ? empty :
      <DataTable columns={[{ label: 'Regra' }, { label: 'CST PIS' }, { label: 'Alíquota PIS' }, { label: 'CST COFINS' }, { label: 'Alíquota COFINS' }, { label: 'Ações', className: 'text-right' }]}>
        {items.map(rule => <tr key={rule.id}><td className="font-medium text-slate-900">{rule.name}</td><td>{rule.pisCst || '—'}</td><td>{percent(rule.pisRate)}</td><td>{rule.cofinsCst || '—'}</td><td>{percent(rule.cofinsRate)}</td>{rowActions(rule)}</tr>)}
      </DataTable>)}

    {tab === 'products' && <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><Select label="Regra tributária" value={ruleId} onChange={e => chooseRule(e.target.value)}><option value="">Selecione uma regra</option>{items.map(rule => <option key={rule.id} value={rule.id}>{rule.name}{rule.active ? '' : ' (inativa)'}</option>)}</Select></div>
      {!ruleId ? <EmptyState icon="🧾" title="Selecione uma regra" hint="Escolha a regra para ver e vincular produtos em massa." /> : <>
        <section aria-label="Produtos vinculados"><h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-700">Vinculados ({linked.length})</h3>
          {linked.length === 0 ? <EmptyState icon="📦" title="Não há registros" hint="Nenhum produto vinculado a esta regra." /> :
            <DataTable columns={[{ label: 'Produto' }, { label: 'Código' }, { label: 'Categoria' }, { label: 'Ações', className: 'text-right' }]}>
              {linked.map(product => <tr key={product.id}><td className="font-medium text-slate-900">{product.name}</td><td>{product.code || '—'}</td><td>{product.category?.name ?? '—'}</td><td><div className="flex justify-end"><button className={secondaryButtonClass} onClick={() => void unassign(product.id)}>Desvincular</button></div></td></tr>)}
            </DataTable>}
        </section>
        <section aria-label="Vincular produtos" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Vincular produtos em massa</h3>
          <div className="mb-3 flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1 basis-56"><Field label="Filtrar produtos" type="search" placeholder="Nome ou código" value={productQ} onChange={e => setProductQ(e.target.value)} /></div>
            <button type="button" className={secondaryButtonClass} onClick={() => setPicked(current => Array.from(new Set([...current, ...candidates.map(product => product.id)])))} disabled={candidates.length === 0}>Selecionar todos ({candidates.length})</button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPicked([])} disabled={picked.length === 0}>Limpar</button>
            <button type="button" className={buttonClass} onClick={() => void assign()} disabled={picked.length === 0 || items.find(rule => rule.id === ruleId)?.active === false}>Vincular {picked.length > 0 ? `${picked.length} produto(s)` : 'selecionados'}</button></div>
          {!catalogLoaded ? <p className="text-sm text-slate-500">Carregando produtos…</p> : candidates.length === 0 ? <p className="text-sm text-slate-500">Nenhum produto disponível para vincular.</p> :
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">{candidates.map(product => <li key={product.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-brand-50/40"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={picked.includes(product.id)} onChange={e => setPicked(current => e.target.checked ? [...current, product.id] : current.filter(id => id !== product.id))} /><span className="min-w-0 flex-1 truncate">{product.name}{product.code ? <span className="text-slate-400"> · {product.code}</span> : null}</span>{product.taxRuleId && <Badge tone="amber">{ruleName(product.taxRuleId) ?? 'Outra regra'}</Badge>}</label></li>)}</ul>}
          <p className="mt-2 text-xs text-slate-500">Produtos que já têm outra regra passam para esta regra ao serem vinculados.</p>
        </section>
      </>}
    </div>}
  </AppShell>;
}

export default function TaxRulesPage() {
  return <Suspense fallback={null}><TaxRulesContent /></Suspense>;
}
