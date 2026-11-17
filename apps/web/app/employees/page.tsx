'use client';

import { useEffect, useState } from 'react';
import { api, Employee, ListResponse, Unit } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

export default function EmployeesPage() {
  const [items, setItems] = useState<Employee[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [message, setMessage] = useState('');
  const [form, setForm] = useState({ fullName: '', position: '', phone: '', email: '', unitId: '' });
  async function load() { try { const [people, locations] = await Promise.all([api<ListResponse<Employee>>('/employees'), api<ListResponse<Unit>>('/units')]); setItems(people.items); setUnits(locations.items); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao carregar funcionários'); } }
  useEffect(() => { void load(); }, []);
  async function submit(event: React.FormEvent) { event.preventDefault(); setMessage(''); try { await api('/employees', { method: 'POST', body: JSON.stringify({ ...form, email: form.email || undefined, unitId: form.unitId || undefined }) }); setForm({ fullName: '', position: '', phone: '', email: '', unitId: '' }); setMessage('Funcionário cadastrado.'); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao cadastrar funcionário'); } }
  return <AppShell title="Funcionários">
    {message && <Notice message={message} kind={message.includes('cadastrado') ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Novo funcionário</h2><form onSubmit={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Field label="Nome completo" required value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /><Field label="Cargo" value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} /><Field label="Telefone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /><Field label="E-mail" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /><label className="text-sm text-slate-300">Unidade<select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Unidade padrão do acesso</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label><div className="flex items-end"><button className={buttonClass}>Cadastrar</button></div></form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Equipe ({items.length})</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Nome</th><th className="p-3">Cargo</th><th className="p-3">Contato</th><th className="p-3">Status</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-t border-slate-800"><td className="p-3">{item.fullName}</td><td className="p-3">{item.position || '—'}</td><td className="p-3">{item.phone || item.email || '—'}</td><td className="p-3">{item.status}</td></tr>)}</tbody></table>{items.length === 0 && <p className="p-4 text-slate-400">Nenhum funcionário cadastrado.</p>}</div></section>
  </AppShell>;
}
