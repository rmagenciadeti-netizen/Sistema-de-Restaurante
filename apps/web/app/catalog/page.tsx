'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, ListResponse, ModifierGroup, ModifierOption, Product, ProductComposition, ProductionSector } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

type OptionRow = { name: string; price: string; sectorId: string };
type ComponentRow = { productId: string; quantity: string };
const emptyOption: OptionRow = { name: '', price: '0', sectorId: '' };
const emptyGroup = { name: '', minSelect: '0', maxSelect: '1' };

export default function CatalogPage() {
  const [groups, setGroups] = useState<ModifierGroup[]>([]); const [sectors, setSectors] = useState<ProductionSector[]>([]); const [products, setProducts] = useState<Product[]>([]);
  const [groupForm, setGroupForm] = useState(emptyGroup); const [optionRows, setOptionRows] = useState<OptionRow[]>([{ ...emptyOption }]);
  const [editingGroup, setEditingGroup] = useState<string | null>(null); const [groupDraft, setGroupDraft] = useState(emptyGroup);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({}); const [newOptions, setNewOptions] = useState<Record<string, OptionRow>>({});
  const [productId, setProductId] = useState(''); const [composition, setComposition] = useState<ProductComposition | null>(null); const [assigned, setAssigned] = useState<string[]>([]); const [components, setComponents] = useState<ComponentRow[]>([]);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [g, s, p] = await Promise.all([api<ListResponse<ModifierGroup>>('/catalog/modifier-groups'), api<ListResponse<ProductionSector>>('/production/sectors').catch(() => ({ items: [] as ProductionSector[], total: 0 })), api<ListResponse<Product>>('/products')]);
      setGroups(g.items); setSectors(s.items.filter(sector => sector.active)); setProducts(p.items);
    } catch (e) { fail(e, 'Erro ao carregar o catálogo'); }
  }
  useAutoLoad(load);

  const sectorSelect = (value: string, onChange: (value: string) => void, label = 'Setor (opcional)') => <Select label={label} value={value} onChange={e => onChange(e.target.value)}><option value="">Setor do produto</option>{sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</Select>;
  const optionBody = (row: OptionRow) => ({ name: row.name.trim(), price: Number(row.price) || 0, sectorId: row.sectorId || null });

  async function createGroup(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { await api('/catalog/modifier-groups', { method: 'POST', body: JSON.stringify({ name: groupForm.name, minSelect: Number(groupForm.minSelect), maxSelect: Number(groupForm.maxSelect), options: optionRows.map(optionBody) }) }); ok('Grupo de adicionais criado.'); setGroupForm(emptyGroup); setOptionRows([{ ...emptyOption }]); await load(); } catch (e) { fail(e, 'Erro ao criar grupo'); }
  }
  async function patchGroup(group: ModifierGroup, body: object, success: string) {
    try { await api(`/catalog/modifier-groups/${group.id}`, { method: 'PATCH', body: JSON.stringify(body) }); ok(success); setEditingGroup(null); await load(); } catch (e) { fail(e, 'Erro ao atualizar grupo'); }
  }
  async function patchOption(option: ModifierOption, body: object, success: string) {
    try { await api(`/catalog/modifier-options/${option.id}`, { method: 'PATCH', body: JSON.stringify(body) }); ok(success); setPriceDrafts(current => { const next = { ...current }; delete next[option.id]; return next; }); await load(); } catch (e) { fail(e, 'Erro ao atualizar opção'); }
  }
  async function addOption(group: ModifierGroup) {
    const row = newOptions[group.id] ?? emptyOption;
    try { await api(`/catalog/modifier-groups/${group.id}/options`, { method: 'POST', body: JSON.stringify(optionBody(row)) }); ok('Opção adicionada.'); setNewOptions(current => ({ ...current, [group.id]: { ...emptyOption } })); await load(); } catch (e) { fail(e, 'Erro ao adicionar opção'); }
  }

  async function chooseProduct(id: string) {
    setProductId(id); setComposition(null); setAssigned([]); setComponents([]);
    if (!id) return;
    try {
      const data = await api<ProductComposition>(`/catalog/products/${id}/composition`);
      setComposition(data); setAssigned(data.modifierGroups.map(link => link.groupId)); setComponents(data.comboComponents.map(component => ({ productId: component.product.id, quantity: String(component.quantity) })));
    } catch (e) { fail(e, 'Erro ao carregar composição do produto'); }
  }
  async function saveAssignment() {
    try { await api(`/catalog/products/${productId}/modifier-groups`, { method: 'PUT', body: JSON.stringify({ groupIds: assigned }) }); ok('Grupos de adicionais do produto salvos.'); await chooseProduct(productId); await load(); } catch (e) { fail(e, 'Erro ao salvar grupos do produto'); }
  }
  async function saveCombo() {
    const lines = components.filter(row => row.productId).map(row => ({ productId: row.productId, quantity: Number(row.quantity) || 1 }));
    try { await api(`/catalog/products/${productId}/combo`, { method: 'PUT', body: JSON.stringify({ components: lines }) }); ok(lines.length ? 'Combo salvo.' : 'Combo desativado.'); await chooseProduct(productId); await load(); } catch (e) { fail(e, 'Erro ao salvar combo'); }
  }
  const updateComponent = (index: number, patch: Partial<ComponentRow>) => setComponents(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const componentCandidates = products.filter(product => product.id !== productId && !product.isCombo && product.active);

  return <AppShell title="Adicionais e combos">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Novo grupo de adicionais</h2>
      <form onSubmit={createGroup} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3"><Field label="Nome do grupo" required minLength={2} maxLength={100} value={groupForm.name} onChange={e => setGroupForm({ ...groupForm, name: e.target.value })} /><Field label="Mínimo de escolhas" type="number" min="0" max="50" required value={groupForm.minSelect} onChange={e => setGroupForm({ ...groupForm, minSelect: e.target.value })} /><Field label="Máximo de escolhas" type="number" min="1" max="50" required value={groupForm.maxSelect} onChange={e => setGroupForm({ ...groupForm, maxSelect: e.target.value })} /></div>
        {optionRows.map((row, index) => <div key={index} className="grid items-end gap-3 md:grid-cols-[2fr_1fr_2fr_auto]"><Field label={index === 0 ? 'Opção' : ''} aria-label="Nome da opção" required maxLength={100} value={row.name} onChange={e => setOptionRows(current => current.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} /><Field label={index === 0 ? 'Preço (R$)' : ''} aria-label="Preço da opção" type="number" min="0" step="0.01" required value={row.price} onChange={e => setOptionRows(current => current.map((item, i) => i === index ? { ...item, price: e.target.value } : item))} />{sectorSelect(row.sectorId, value => setOptionRows(current => current.map((item, i) => i === index ? { ...item, sectorId: value } : item)), index === 0 ? 'Setor (opcional)' : '')}<button type="button" className={secondaryButtonClass} disabled={optionRows.length === 1} onClick={() => setOptionRows(current => current.filter((_, i) => i !== index))}>Remover</button></div>)}
        <div className="flex gap-3"><button type="button" className={secondaryButtonClass} disabled={optionRows.length >= 100} onClick={() => setOptionRows(current => [...current, { ...emptyOption }])}>+ Adicionar opção</button><button className={buttonClass}>Criar grupo</button></div>
      </form></section>

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Grupos de adicionais ({groups.length})</h2><div className="grid gap-4">{groups.map(group => {
      const draft = newOptions[group.id] ?? emptyOption;
      return <article key={group.id} className="rounded-lg border border-slate-800 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{group.name} {!group.active && <span className="text-xs text-red-300">inativo</span>}</h3><p className="mt-1 text-sm text-slate-400">Escolha de {group.minSelect} a {group.maxSelect} · usado em {group.products?.length ?? 0} produto(s)</p></div><div className="flex gap-2"><button className={secondaryButtonClass} onClick={() => { setEditingGroup(editingGroup === group.id ? null : group.id); setGroupDraft({ name: group.name, minSelect: String(group.minSelect), maxSelect: String(group.maxSelect) }); }}>Editar grupo</button><button className={secondaryButtonClass} onClick={() => void patchGroup(group, { active: !group.active }, group.active ? 'Grupo desativado.' : 'Grupo ativado.')}>{group.active ? 'Desativar' : 'Ativar'}</button></div></div>
        {editingGroup === group.id && <div className="mt-3 grid items-end gap-3 md:grid-cols-4"><Field label="Nome" value={groupDraft.name} onChange={e => setGroupDraft({ ...groupDraft, name: e.target.value })} /><Field label="Mínimo" type="number" min="0" max="50" value={groupDraft.minSelect} onChange={e => setGroupDraft({ ...groupDraft, minSelect: e.target.value })} /><Field label="Máximo" type="number" min="1" max="50" value={groupDraft.maxSelect} onChange={e => setGroupDraft({ ...groupDraft, maxSelect: e.target.value })} /><button className={buttonClass} onClick={() => void patchGroup(group, { name: groupDraft.name, minSelect: Number(groupDraft.minSelect), maxSelect: Number(groupDraft.maxSelect) }, 'Grupo atualizado.')}>Salvar grupo</button></div>}
        <div className="mt-3 grid gap-2">{group.options.map(option => <div key={option.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-sm"><span className={`min-w-32 flex-1 ${option.active === false ? 'text-slate-500 line-through' : ''}`}>{option.name} <span className="text-slate-400">{formatMoney(option.price)}</span></span><input aria-label={`Novo preço de ${option.name}`} type="number" min="0" step="0.01" placeholder="Novo preço" className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-white" value={priceDrafts[option.id] ?? ''} onChange={e => setPriceDrafts({ ...priceDrafts, [option.id]: e.target.value })} /><button className={secondaryButtonClass} disabled={!priceDrafts[option.id]} onClick={() => void patchOption(option, { price: Number(priceDrafts[option.id]) }, 'Preço atualizado.')}>Salvar preço</button><select aria-label={`Setor de ${option.name}`} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-white" value={option.sectorId ?? ''} onChange={e => void patchOption(option, { sectorId: e.target.value || null }, 'Setor da opção atualizado.')}><option value="">Setor do produto</option>{sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select><button className={secondaryButtonClass} onClick={() => void patchOption(option, { active: option.active === false }, option.active === false ? 'Opção ativada.' : 'Opção desativada.')}>{option.active === false ? 'Ativar' : 'Desativar'}</button></div>)}</div>
        <div className="mt-3 grid items-end gap-3 md:grid-cols-[2fr_1fr_2fr_auto]"><Field label="Nova opção" maxLength={100} value={draft.name} onChange={e => setNewOptions({ ...newOptions, [group.id]: { ...draft, name: e.target.value } })} /><Field label="Preço (R$)" type="number" min="0" step="0.01" value={draft.price} onChange={e => setNewOptions({ ...newOptions, [group.id]: { ...draft, price: e.target.value } })} />{sectorSelect(draft.sectorId, value => setNewOptions({ ...newOptions, [group.id]: { ...draft, sectorId: value } }))}<button className={buttonClass} disabled={!draft.name.trim()} onClick={() => void addOption(group)}>Adicionar opção</button></div>
      </article>;
    })}</div>{groups.length === 0 && <p className="text-slate-400">Nenhum grupo cadastrado.</p>}</section>

    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Produto: adicionais e combo</h2>
      <div className="max-w-md"><Select label="Produto" value={productId} onChange={e => void chooseProduct(e.target.value)}><option value="">Selecione</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}{product.isCombo ? ' (combo)' : ''}</option>)}</Select></div>
      {composition && <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div><h3 className="mb-3 font-semibold">Grupos de adicionais de “{composition.name}”</h3><div className="grid gap-2">{groups.map(group => <Check key={group.id} label={`${group.name} (${group.minSelect}–${group.maxSelect}${group.active ? '' : ', inativo'})`} checked={assigned.includes(group.id)} onChange={e => setAssigned(current => e.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />)}</div>{groups.length === 0 && <p className="text-sm text-slate-400">Crie um grupo primeiro.</p>}<button className={`${buttonClass} mt-4`} onClick={() => void saveAssignment()}>Salvar adicionais</button></div>
        <div><h3 className="mb-1 font-semibold">Combo {composition.isCombo && <span className="text-xs text-blue-300">ativo</span>}</h3><p className="mb-3 text-sm text-slate-400">Cada componente é produzido e impresso pelo seu próprio setor. Salvar sem componentes desativa o combo.</p>
          <div className="grid gap-3">{components.map((row, index) => <div key={index} className="grid items-end gap-3 grid-cols-[2fr_1fr_auto]"><Select label={index === 0 ? 'Componente' : ''} aria-label="Componente" value={row.productId} onChange={e => updateComponent(index, { productId: e.target.value })}><option value="">Selecione</option>{componentCandidates.map(product => <option key={product.id} value={product.id} disabled={components.some((other, i) => i !== index && other.productId === product.id)}>{product.name}</option>)}</Select><Field label={index === 0 ? 'Qtd.' : ''} aria-label="Quantidade" type="number" min="1" max="50" value={row.quantity} onChange={e => updateComponent(index, { quantity: e.target.value })} /><button type="button" className={secondaryButtonClass} onClick={() => setComponents(current => current.filter((_, i) => i !== index))}>Remover</button></div>)}</div>
          <div className="mt-4 flex gap-3"><button type="button" className={secondaryButtonClass} disabled={components.length >= 30} onClick={() => setComponents(current => [...current, { productId: '', quantity: '1' }])}>+ Componente</button><button className={buttonClass} onClick={() => void saveCombo()}>Salvar combo</button></div></div>
      </div>}
    </section>
  </AppShell>;
}
