'use client';

import { useState } from 'react';
import { api, AppUser, errorMessage, ListResponse, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const roles: Record<string, string> = { ADMIN: 'Administrador', MANAGER: 'Gerente', CASHIER: 'Caixa', WAITER: 'Garçom', KITCHEN: 'Cozinha', DELIVERY: 'Entregador', FINANCE: 'Financeiro', SUPPORT: 'Suporte' };
const statuses: Record<string, string> = { ACTIVE: 'Ativo', INACTIVE: 'Inativo', BLOCKED: 'Bloqueado' };
const emptyForm = { name: '', email: '', password: '', role: 'WAITER', unitId: '', commissionPercent: '0', status: 'ACTIVE' };

export default function UsersPage() {
  const [items, setItems] = useState<AppUser[]>([]); const [units, setUnits] = useState<Unit[]>([]);
  const [form, setForm] = useState(emptyForm); const [editing, setEditing] = useState<AppUser | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [users, unitList] = await Promise.all([api<ListResponse<AppUser>>('/users'), api<ListResponse<Unit>>('/units')]);
      setItems(users.items); setUnits(unitList.items);
    } catch (e) { fail(e, 'Erro ao carregar usuários'); }
  }
  useAutoLoad(load);

  function startEdit(user: AppUser) {
    setEditing(user);
    setForm({ name: user.name, email: user.email, password: '', role: user.role, unitId: user.unitId ?? '', commissionPercent: String(Number(user.commissionPercent ?? 0)), status: user.status });
  }
  function reset() { setEditing(null); setForm(emptyForm); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try {
      if (editing) {
        const body = { name: form.name, role: form.role, status: form.status, commissionPercent: Number(form.commissionPercent) || 0, ...(form.unitId !== (editing.unitId ?? '') ? { unitId: form.unitId || null } : {}), ...(form.password ? { password: form.password } : {}) };
        await api(`/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        ok(form.password ? 'Usuário atualizado e senha redefinida.' : 'Usuário atualizado.');
      } else {
        await api('/users', { method: 'POST', body: JSON.stringify({ name: form.name, email: form.email, password: form.password, role: form.role, unitId: form.unitId || undefined, commissionPercent: Number(form.commissionPercent) || 0 }) });
        ok('Usuário criado.');
      }
      reset(); await load();
    } catch (e) { fail(e, 'Erro ao salvar usuário'); }
  }
  const unitName = (id?: string | null) => (id ? units.find(unit => unit.id === id)?.name ?? 'Unidade' : 'Todas as unidades');

  return <AppShell title="Usuários e permissões">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{editing ? `Editar ${editing.name}` : 'Novo usuário'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-3">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="E-mail" type="email" required disabled={!!editing} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        <Field label={editing ? 'Nova senha (deixe em branco para manter)' : 'Senha (mín. 10 caracteres)'} type="password" autoComplete="new-password" required={!editing} minLength={10} maxLength={200} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        <Select label="Perfil" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select label="Unidade" value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Todas as unidades</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>
        <Field label="Comissão (%)" type="number" min="0" max="100" step="0.01" value={form.commissionPercent} onChange={e => setForm({ ...form, commissionPercent: e.target.value })} />
        {editing && <Select label="Situação" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}
        <div className="flex items-end gap-2 md:col-span-3"><button className={buttonClass}>{editing ? 'Salvar usuário' : 'Criar usuário'}</button>{editing && <button type="button" className={secondaryButtonClass} onClick={reset}>Cancelar edição</button>}</div>
      </form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Usuários ({items.length})</h2><div className="grid gap-3 md:grid-cols-2">{items.map(user => <article key={user.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 p-4"><div><h3 className="font-semibold">{user.name} <span className={`text-xs ${user.status === 'ACTIVE' ? 'text-emerald-300' : 'text-red-300'}`}>{statuses[user.status] ?? user.status}</span></h3><p className="mt-1 text-sm text-slate-400">{user.email}</p><p className="mt-1 text-sm text-slate-300">{roles[user.role] ?? user.role} · {unitName(user.unitId)} · comissão {Number(user.commissionPercent ?? 0)}%</p></div><button className={secondaryButtonClass} onClick={() => startEdit(user)}>Editar</button></article>)}</div>{items.length === 0 && <p className="text-slate-400">Nenhum usuário encontrado.</p>}</section>
  </AppShell>;
}
