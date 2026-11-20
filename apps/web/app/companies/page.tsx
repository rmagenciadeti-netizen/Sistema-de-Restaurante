'use client';

import Link from '../../components/nav-link';
import { useEffect, useState } from 'react';
import { api, Tenant, errorMessage } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { CompanyEditDialog } from '../../components/companies/edit-dialog';

export default function CompaniesPage() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [plans, setPlans] = useState<{ id: string; name: string; key: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', plan: 'BASIC', commercialPlanId: '', adminName: '', adminEmail: '', adminPassword: '', unitName: 'Matriz' });
  async function load() { try { const result = await api<{ items: Tenant[] }>('/tenants'); setItems(result.items); } catch (e) { setSuccess(false); setMessage(errorMessage(e, 'Erro ao carregar empresas')); } }
  useEffect(() => {
    let active = true;
    Promise.all([api<{ items: Tenant[] }>('/tenants'), api<{ items: { id: string; name: string; key: string; status: string }[] }>('/plans')])
      .then(([companies, commercialPlans]) => { if (active) { setItems(companies.items); setPlans(commercialPlans.items.filter(plan => plan.status === 'ACTIVE')); } })
      .catch(e => { if (active) { setSuccess(false); setMessage(errorMessage(e, 'Erro ao carregar empresas e planos comerciais')); } });
    return () => { active = false; };
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const { commercialPlanId, ...values } = form;
      await api<{ provisioning?: { status: string } }>('/tenants', {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ ...values, ...(commercialPlanId ? { commercialPlanId } : {}) }),
      });
      setSuccess(true); setMessage(`Empresa provisionada. ${commercialPlanId ? 'A licença comercial foi criada como pendente e precisa ser liberada em Clientes e assinaturas.' : ''}`);
      setForm({ name: '', slug: '', plan: 'BASIC', commercialPlanId: '', adminName: '', adminEmail: '', adminPassword: '', unitName: 'Matriz' }); await load();
    }
    catch (e) { setSuccess(false); setMessage(errorMessage(e, 'Erro ao cadastrar empresa')); }
    finally { setBusy(false); }
  }
  async function changeStatus(id: string, status: string) { try { await api(`/tenants/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { setSuccess(false); setMessage(errorMessage(e, 'Falha ao atualizar status')); } }
  return <AppShell title="Empresas e unidades">
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Cadastrar empresa</h2><form onSubmit={create} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Field label="Nome da empresa" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <Field label="Slug" required value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
      <label className="text-sm text-slate-300">Plano<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={form.plan} onChange={e => setForm({ ...form, plan: e.target.value })}><option value="BASIC">Básico</option><option value="PRO">Profissional</option><option value="PREMIUM">Premium</option><option value="ENTERPRISE">Enterprise</option></select></label>
      <Select label="Plano comercial (opcional)" value={form.commercialPlanId} onChange={e => setForm({ ...form, commercialPlanId: e.target.value })}><option value="">Não vincular</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</Select>
      <Field label="Nome do administrador" required value={form.adminName} onChange={e => setForm({ ...form, adminName: e.target.value })} />
      <Field label="E-mail do administrador" type="email" required value={form.adminEmail} onChange={e => setForm({ ...form, adminEmail: e.target.value })} />
      <Field label="Senha inicial (mín. 12 caracteres)" type="password" minLength={12} required value={form.adminPassword} onChange={e => setForm({ ...form, adminPassword: e.target.value })} />
      <Field label="Unidade inicial" required value={form.unitName} onChange={e => setForm({ ...form, unitName: e.target.value })} />
      <div className="flex items-end"><button className={buttonClass} disabled={busy}>{busy ? 'Provisionando...' : 'Criar empresa'}</button></div>
    </form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Empresas cadastradas ({items.length})</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Empresa</th><th className="p-3">Plano</th><th className="p-3">Unidades</th><th className="p-3">Usuários</th><th className="p-3">Status</th><th className="p-3">Ação</th><th className="p-3">Dados</th><th className="p-3">Editar</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-t border-slate-800"><td className="p-3"><div className="font-medium">{item.name}</div><div className="text-xs text-slate-500">{item.slug}</div>{item.company?.document && <div className="text-xs text-slate-500">CNPJ {item.company.document}</div>}{item.company?.legalName && <div className="text-xs text-slate-500">{item.company.legalName}</div>}</td><td className="p-3">{item.plan}</td><td className="p-3">{item._count?.units ?? '—'}</td><td className="p-3">{item._count?.users ?? '—'}</td><td className="p-3">{item.status}</td><td className="p-3"><select aria-label={`Status de ${item.name}`} className="rounded border border-slate-700 bg-slate-950 p-2" value={item.status} onChange={e => void changeStatus(item.id, e.target.value)}><option value="TRIAL">Teste</option><option value="ACTIVE">Ativa</option><option value="SUSPENDED">Suspensa</option><option value="BLOCKED">Bloqueada</option></select></td><td className="p-3"><Link className="text-brand-600 underline" href={`/migrations?tenantId=${item.id}`}>Migração de Dados</Link></td><td className="p-3"><button type="button" className={secondaryButtonClass} aria-label={`Editar ${item.name}`} onClick={() => setEditingId(item.id)}>Editar</button></td></tr>)}</tbody></table>{items.length === 0 && <p className="p-4 text-slate-400">Nenhuma empresa cadastrada.</p>}</div></section>
  {editingId && <CompanyEditDialog tenantId={editingId} onClose={() => setEditingId(null)} onSaved={text => { setEditingId(null); setSuccess(true); setMessage(text); void load(); }} />}
  </AppShell>;
}
