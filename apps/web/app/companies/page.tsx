'use client';

import { useEffect, useState } from 'react';
import { api, Tenant } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

export default function CompaniesPage() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', slug: '', plan: 'BASIC', adminName: '', adminEmail: '', adminPassword: '', unitName: 'Matriz' });
  async function load() { try { const result = await api<{ items: Tenant[] }>('/tenants'); setItems(result.items); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao carregar empresas'); } }
  useEffect(() => { void load(); }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api('/tenants', { method: 'POST', body: JSON.stringify(form) }); setMessage('Empresa e acesso administrativo criados.'); setForm({ name: '', slug: '', plan: 'BASIC', adminName: '', adminEmail: '', adminPassword: '', unitName: 'Matriz' }); await load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao cadastrar empresa'); }
    finally { setBusy(false); }
  }
  async function changeStatus(id: string, status: string) { try { await api(`/tenants/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Falha ao atualizar status'); } }
  return <AppShell title="Empresas e unidades">
    {message && <Notice message={message} kind={message.includes('criados') ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Cadastrar empresa</h2><form onSubmit={create} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Field label="Nome da empresa" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <Field label="Slug" required value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
      <label className="text-sm text-slate-300">Plano<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={form.plan} onChange={e => setForm({ ...form, plan: e.target.value })}><option value="BASIC">Básico</option><option value="PRO">Profissional</option><option value="PREMIUM">Premium</option><option value="ENTERPRISE">Enterprise</option></select></label>
      <Field label="Nome do administrador" required value={form.adminName} onChange={e => setForm({ ...form, adminName: e.target.value })} />
      <Field label="E-mail do administrador" type="email" required value={form.adminEmail} onChange={e => setForm({ ...form, adminEmail: e.target.value })} />
      <Field label="Senha inicial (mín. 12 caracteres)" type="password" minLength={12} required value={form.adminPassword} onChange={e => setForm({ ...form, adminPassword: e.target.value })} />
      <Field label="Unidade inicial" required value={form.unitName} onChange={e => setForm({ ...form, unitName: e.target.value })} />
      <div className="flex items-end"><button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : 'Criar empresa'}</button></div>
    </form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Empresas cadastradas ({items.length})</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Empresa</th><th className="p-3">Plano</th><th className="p-3">Unidades</th><th className="p-3">Usuários</th><th className="p-3">Status</th><th className="p-3">Ação</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-t border-slate-800"><td className="p-3"><div className="font-medium">{item.name}</div><div className="text-xs text-slate-500">{item.slug}</div></td><td className="p-3">{item.plan}</td><td className="p-3">{item._count?.units ?? '—'}</td><td className="p-3">{item._count?.users ?? '—'}</td><td className="p-3">{item.status}</td><td className="p-3"><select aria-label={`Status de ${item.name}`} className="rounded border border-slate-700 bg-slate-950 p-2" value={item.status} onChange={e => void changeStatus(item.id, e.target.value)}><option value="TRIAL">Teste</option><option value="ACTIVE">Ativa</option><option value="SUSPENDED">Suspensa</option><option value="BLOCKED">Bloqueada</option></select></td></tr>)}</tbody></table>{items.length === 0 && <p className="p-4 text-slate-400">Nenhuma empresa cadastrada.</p>}</div></section>
  </AppShell>;
}
