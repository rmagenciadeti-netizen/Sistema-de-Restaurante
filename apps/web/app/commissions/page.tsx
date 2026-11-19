'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, type ListResponse, type Product } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';

type Rule = { id: string; name: string; kind: 'SALE_PERCENT' | 'PRODUCT_PERCENT' | 'GOAL_BONUS'; userId: string | null; role: string | null; productId: string | null; percent: number | null; goalAmount: number | null; bonusAmount: number | null; active: boolean };
type Line = { userId: string; name: string; role: string; sales: number; saleCommission: number; productCommission: number; goalBonus: number; total: number; goalsReached: string[] };
type Statement = { items: Line[]; totals: { sales: number; commission: number }; note: string };
type Closing = { id: string; periodFrom: string; periodTo: string; closedTotal: number; currentTotal: number; adjustment: number };
type Person = { id: string; name: string; role: string };
const kindLabels = { SALE_PERCENT: '% sobre a venda', PRODUCT_PERCENT: '% por produto', GOAL_BONUS: 'Bônus por meta' };
const roleLabels: Record<string, string> = { ADMIN: 'Administrador', MANAGER: 'Gerente', CASHIER: 'Caixa', WAITER: 'Garçom', KITCHEN: 'Cozinha', DELIVERY: 'Entregador', FINANCE: 'Financeiro' };
const firstOfMonth = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`; };
const today = () => new Date().toISOString().slice(0, 10);
const blank = { name: '', kind: 'SALE_PERCENT' as Rule['kind'], userId: '', role: '', productId: '', percent: '', goalAmount: '', bonusAmount: '' };

export default function CommissionsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [closings, setClosings] = useState<Closing[]>([]);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [range, setRange] = useState({ from: firstOfMonth(), to: today() });
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (cause: unknown, fallback: string) => setNotice({ text: errorMessage(cause, fallback), kind: 'error' });

  async function loadStatement(period = range) {
    try { setStatement(await api<Statement>(`/commissions/statement?from=${period.from}T00:00:00&to=${period.to}T23:59:59`)); } catch (cause) { fail(cause, 'Falha ao calcular as comissões'); }
  }
  async function load() {
    try {
      const [ruleList, users, productList] = await Promise.all([api<{ items: Rule[] }>('/commissions/rules'), api<ListResponse<Person>>('/users').catch(() => ({ items: [] as Person[] })), api<ListResponse<Product>>('/products?pageSize=200').catch(() => ({ items: [] as Product[] }))]);
      setRules(ruleList.items); setPeople(users.items); setProducts(productList.items);
    } catch (cause) { fail(cause, 'Falha ao carregar as regras'); }
    try { setClosings((await api<{ items: Closing[] }>('/commissions/closings')).items); } catch { setClosings([]); }
    await loadStatement();
  }
  useAutoLoad(load);

  async function closePeriod() {
    if (!window.confirm('Fechar o período? Os valores ficam congelados; cancelamentos posteriores aparecem como ajuste.')) return;
    try { await api('/commissions/closings', { method: 'POST', body: JSON.stringify({ from: `${range.from}T00:00:00`, to: `${range.to}T23:59:59` }) }); setNotice({ text: 'Período fechado.', kind: 'success' }); await load(); } catch (cause) { fail(cause, 'Falha ao fechar o período'); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const body = {
      name: form.name, kind: form.kind, userId: form.userId || null, role: form.role || null, productId: form.kind === 'PRODUCT_PERCENT' ? form.productId || null : null,
      percent: form.kind === 'GOAL_BONUS' ? null : Number(form.percent), goalAmount: form.kind === 'GOAL_BONUS' ? Number(form.goalAmount) : null, bonusAmount: form.kind === 'GOAL_BONUS' ? Number(form.bonusAmount) : null, active: true,
    };
    try {
      await api(editing ? `/commissions/rules/${editing}` : '/commissions/rules', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setForm(blank); setEditing(null); setNotice({ text: 'Regra salva.', kind: 'success' }); await load();
    } catch (cause) { fail(cause, 'Falha ao salvar a regra'); }
  }
  async function toggle(rule: Rule) {
    try { await api(`/commissions/rules/${rule.id}`, { method: 'PUT', body: JSON.stringify({ ...rule, active: !rule.active }) }); await load(); } catch (cause) { fail(cause, 'Falha ao atualizar a regra'); }
  }
  async function remove(rule: Rule) {
    if (!window.confirm(`Excluir a regra "${rule.name}"?`)) return;
    try { await api(`/commissions/rules/${rule.id}`, { method: 'DELETE' }); await load(); } catch (cause) { fail(cause, 'Falha ao excluir a regra'); }
  }
  function edit(rule: Rule) {
    setEditing(rule.id);
    setForm({ name: rule.name, kind: rule.kind, userId: rule.userId ?? '', role: rule.role ?? '', productId: rule.productId ?? '', percent: rule.percent?.toString() ?? '', goalAmount: rule.goalAmount?.toString() ?? '', bonusAmount: rule.bonusAmount?.toString() ?? '' });
  }
  const scope = (rule: Rule) => [rule.userId ? people.find(person => person.id === rule.userId)?.name ?? 'Colaborador' : null, rule.role ? roleLabels[rule.role] ?? rule.role : null, rule.productId ? products.find(product => product.id === rule.productId)?.name ?? 'Produto' : null].filter(Boolean).join(' · ') || 'Todos';
  const value = (rule: Rule) => (rule.kind === 'GOAL_BONUS' ? `${formatMoney(rule.bonusAmount ?? 0)} ao atingir ${formatMoney(rule.goalAmount ?? 0)}` : `${rule.percent}%`);

  return <AppShell title="Comissões">
    <PageHeader title="Comissões e produtividade" subtitle="Regras por colaborador, função, produto ou meta. O cálculo usa apenas vendas concluídas e itens não cancelados." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="De" type="date" value={range.from} onChange={event => setRange({ ...range, from: event.target.value })} />
        <Field label="Até" type="date" value={range.to} onChange={event => setRange({ ...range, to: event.target.value })} />
        <button type="button" className={buttonClass} onClick={() => void loadStatement()}>Calcular</button>
        <button type="button" className={secondaryButtonClass} onClick={() => void closePeriod()}>Fechar período</button>
      </div>
      {!statement || statement.items.length === 0 ? <EmptyState title="Sem vendas elegíveis no período" /> : <>
        <DataTable columns={[{ label: 'Colaborador' }, { label: 'Função' }, { label: 'Vendas' }, { label: '% venda' }, { label: '% produto' }, { label: 'Bônus' }, { label: 'Comissão' }]}>
          {statement.items.map(line => <tr key={line.userId}><td>{line.name}{line.goalsReached.map(goal => <span key={goal} className="ml-1"><Badge tone="green">{goal}</Badge></span>)}</td><td>{roleLabels[line.role] ?? line.role}</td><td>{formatMoney(line.sales)}</td><td>{formatMoney(line.saleCommission)}</td><td>{formatMoney(line.productCommission)}</td><td>{formatMoney(line.goalBonus)}</td><td className="font-semibold">{formatMoney(line.total)}</td></tr>)}
        </DataTable>
        <p className="mt-2 text-sm">Total vendido: <strong>{formatMoney(statement.totals.sales)}</strong> · Comissões: <strong>{formatMoney(statement.totals.commission)}</strong></p>
        <p className="text-xs text-slate-500">{statement.note} Sem regra, vale o percentual fixo do cadastro do usuário.</p>
      </>}
    </section>
    {closings.length > 0 && <section className={`${panelClass} mb-6`}>
      <h2 className="mb-3 text-base font-bold">Fechamentos</h2>
      <DataTable columns={[{ label: 'Período' }, { label: 'Fechado' }, { label: 'Hoje' }, { label: 'Ajuste' }]}>
        {closings.map(item => <tr key={item.id}><td>{new Date(item.periodFrom).toLocaleDateString('pt-BR')} a {new Date(item.periodTo).toLocaleDateString('pt-BR')}</td><td>{formatMoney(item.closedTotal)}</td><td>{formatMoney(item.currentTotal)}</td><td className={item.adjustment === 0 ? '' : 'font-semibold text-amber-700'}>{formatMoney(item.adjustment)}</td></tr>)}
      </DataTable>
      <p className="mt-1 text-xs text-slate-500">Ajuste = diferença causada por cancelamentos/estornos depois do fechamento. Acerte no próximo pagamento.</p>
    </section>}
    <section className={`${panelClass} mb-6`}>
      <h2 className="mb-3 text-base font-bold">{editing ? 'Editar regra' : 'Nova regra de comissão'}</h2>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-3">
        <Field label="Nome" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        <Select label="Tipo" value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value as Rule['kind'] })}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Select label="Colaborador (opcional)" value={form.userId} onChange={event => setForm({ ...form, userId: event.target.value })}><option value="">Todos</option>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</Select>
        <Select label="Função (opcional)" value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="">Todas</option>{Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        {form.kind === 'PRODUCT_PERCENT' && <Select label="Produto" required value={form.productId} onChange={event => setForm({ ...form, productId: event.target.value })}><option value="">Selecione</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select>}
        {form.kind !== 'GOAL_BONUS' && <Field label="Percentual (%)" type="number" min={0} max={100} step="0.01" required value={form.percent} onChange={event => setForm({ ...form, percent: event.target.value })} />}
        {form.kind === 'GOAL_BONUS' && <><Field label="Meta de vendas (R$)" type="number" min={0.01} step="0.01" required value={form.goalAmount} onChange={event => setForm({ ...form, goalAmount: event.target.value })} /><Field label="Bônus (R$)" type="number" min={0} step="0.01" required value={form.bonusAmount} onChange={event => setForm({ ...form, bonusAmount: event.target.value })} /></>}
        <div className="flex items-end gap-2"><button className={buttonClass}>{editing ? 'Salvar alterações' : 'Adicionar regra'}</button>{editing && <button type="button" className={secondaryButtonClass} onClick={() => { setEditing(null); setForm(blank); }}>Cancelar</button>}</div>
      </form>
    </section>
    <section className={panelClass}>
      {rules.length === 0 ? <EmptyState title="Nenhuma regra cadastrada" /> : <DataTable columns={[{ label: 'Regra' }, { label: 'Tipo' }, { label: 'Aplica-se a' }, { label: 'Valor' }, { label: 'Situação' }, { label: '' }]}>
        {rules.map(rule => <tr key={rule.id}><td>{rule.name}</td><td>{kindLabels[rule.kind]}</td><td>{scope(rule)}</td><td>{value(rule)}</td><td><Badge tone={rule.active ? 'green' : 'neutral'}>{rule.active ? 'Ativa' : 'Inativa'}</Badge></td>
          <td><div className="flex gap-1"><button type="button" className={secondaryButtonClass} onClick={() => edit(rule)}>Editar</button><button type="button" className={secondaryButtonClass} onClick={() => void toggle(rule)}>{rule.active ? 'Desativar' : 'Ativar'}</button><button type="button" className={secondaryButtonClass} onClick={() => void remove(rule)}>Excluir</button></div></td></tr>)}
      </DataTable>}
    </section>
  </AppShell>;
}
