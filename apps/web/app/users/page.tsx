'use client';

import { useState } from 'react';
import { api, AppUser, Employee, errorMessage, ListResponse, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const roles: Record<string, string> = { ADMIN: 'Administrador', MANAGER: 'Gerente', CASHIER: 'Caixa', WAITER: 'Garçom', KITCHEN: 'Cozinha', DELIVERY: 'Entregador', FINANCE: 'Financeiro', SUPPORT: 'Suporte' };
const statuses: Record<string, string> = { ACTIVE: 'Ativo', INACTIVE: 'Inativo', BLOCKED: 'Bloqueado' };
const emptyForm = { name: '', username: '', email: '', password: '', role: 'WAITER', unitId: '', employeeId: '', commissionPercent: '0', status: 'ACTIVE' };

export default function UsersPage() {
  const [items, setItems] = useState<AppUser[]>([]); const [units, setUnits] = useState<Unit[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]); const [employeePage, setEmployeePage] = useState(1); const [employeeTotal, setEmployeeTotal] = useState(0);
  const [form, setForm] = useState(emptyForm); const [editing, setEditing] = useState<AppUser | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [users, unitList, people] = await Promise.all([api<ListResponse<AppUser>>('/users'), api<ListResponse<Unit>>('/units'), api<ListResponse<Employee>>(`/employees?page=${employeePage}&pageSize=100`)]);
      setItems(users.items); setUnits(unitList.items);
      setEmployees(people.items); setEmployeeTotal(people.total);
    } catch (e) { fail(e, 'Erro ao carregar usuários'); }
  }
  useAutoLoad(load);

  function startEdit(user: AppUser) {
    setEditing(user);
    setForm({ name: user.name, username: user.username ?? '', email: user.email, password: '', role: user.role, unitId: user.unitId ?? '', employeeId: user.employeeId ?? '', commissionPercent: String(Number(user.commissionPercent ?? 0)), status: user.status });
  }
  function reset() { setEditing(null); setForm(emptyForm); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try {
      if (editing) {
        const body = { name: form.name, username: form.username || undefined, role: form.role, status: form.status, commissionPercent: Number(form.commissionPercent) || 0, ...(form.unitId !== (editing.unitId ?? '') ? { unitId: form.unitId || null } : {}), ...(form.employeeId !== (editing.employeeId ?? '') ? { employeeId: form.employeeId || null } : {}), ...(form.password ? { password: form.password } : {}) };
        await api(`/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        ok(form.password ? 'Usuário atualizado e senha redefinida.' : 'Usuário atualizado.');
      } else {
        await api('/users', { method: 'POST', body: JSON.stringify({ name: form.name, username: form.username || undefined, email: form.email, password: form.password, role: form.role, unitId: form.unitId || undefined, employeeId: form.employeeId || undefined, commissionPercent: Number(form.commissionPercent) || 0 }) });
        ok('Usuário criado.');
      }
      reset(); await load();
    } catch (e) { fail(e, 'Erro ao salvar usuário'); }
  }
  const unitName = (id?: string | null) => (id ? units.find(unit => unit.id === id)?.name ?? 'Unidade' : 'Todas as unidades');
  async function changeEmployeePage(next: number) {
    try { const result = await api<ListResponse<Employee>>(`/employees?page=${next}&pageSize=100`); setEmployees(result.items); setEmployeeTotal(result.total); setEmployeePage(next); }
    catch (error) { fail(error, 'Erro ao carregar funcionários'); }
  }

  return <AppShell title="Usuários e permissões">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{editing ? `Editar ${editing.name}` : 'Novo usuário'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-3">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="Nome de usuário (opcional)" maxLength={32} pattern="[A-Za-z0-9._-]{3,32}" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
        <Field label="E-mail" type="email" required disabled={!!editing} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        <Field label={editing ? 'Nova senha (deixe em branco para manter)' : 'Senha (mín. 10 caracteres)'} type="password" autoComplete="new-password" required={!editing} minLength={10} maxLength={200} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        <Select label="Perfil" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select label="Unidade" value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Todas as unidades</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>
        <div><Select label="Funcionário vinculado (opcional)" value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}><option value="">Sem vínculo</option>{form.employeeId && !employees.some(employee => employee.id === form.employeeId) && <option value={form.employeeId}>Funcionário selecionado</option>}{employees.map(employee => <option key={employee.id} value={employee.id} disabled={employee.status !== 'ACTIVE'}>{employee.fullName} {employee.status !== 'ACTIVE' ? '(inativo)' : ''}</option>)}</Select><div className="mt-2 flex items-center gap-2 text-xs text-slate-400"><button type="button" className={secondaryButtonClass} disabled={employeePage <= 1} onClick={() => void changeEmployeePage(employeePage - 1)}>Anterior</button><span>Página {employeePage}</span><button type="button" className={secondaryButtonClass} disabled={employeePage * 100 >= employeeTotal} onClick={() => void changeEmployeePage(employeePage + 1)}>Próxima</button></div></div>
        <Field label="Comissão (%)" type="number" min="0" max="100" step="0.01" value={form.commissionPercent} onChange={e => setForm({ ...form, commissionPercent: e.target.value })} />
        {editing && <Select label="Situação" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}
        <div className="flex items-end gap-2 md:col-span-3"><button className={buttonClass}>{editing ? 'Salvar usuário' : 'Criar usuário'}</button>{editing && <button type="button" className={secondaryButtonClass} onClick={reset}>Cancelar edição</button>}</div>
      </form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Usuários ({items.length})</h2><div className="grid gap-3 md:grid-cols-2">{items.map(user => <article key={user.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-4"><div><h3 className="font-semibold">{user.name} <span className={`text-xs ${user.status === 'ACTIVE' ? 'text-emerald-700' : 'text-red-700'}`}>{statuses[user.status] ?? user.status}</span></h3><p className="mt-1 text-sm text-slate-500">{user.username ? `@${user.username} · ` : ''}{user.email}</p><p className="mt-1 text-sm text-slate-700">{roles[user.role] ?? user.role} · {unitName(user.unitId)} · comissão {Number(user.commissionPercent ?? 0)}%</p><p className="mt-1 text-xs text-slate-500">{user.employeeId ? `Funcionário: ${employees.find(employee => employee.id === user.employeeId)?.fullName ?? 'vinculado'}` : 'Sem funcionário vinculado'}</p></div><button className={secondaryButtonClass} onClick={() => startEdit(user)}>Editar</button></article>)}</div>{items.length === 0 && <p className="text-slate-500">Nenhum usuário encontrado.</p>}</section>
  </AppShell>;
}
