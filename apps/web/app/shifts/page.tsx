'use client';

import { useState } from 'react';
import { api, Employee, errorMessage, ListResponse, Shift, storedUser, toIso, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const pad = (value: number) => String(value).padStart(2, '0');
const dateStr = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDate = (value: string) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (value: string, days: number) => { const date = parseDate(value); date.setDate(date.getDate() + days); return dateStr(date); };
const mondayOf = (date: Date) => { const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate()); copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7)); return dateStr(copy); };
const toLocalInput = (iso: string) => { const d = new Date(iso); return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const weekdays = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const emptyForm = { employeeId: '', unitId: '', startsAt: '', endsAt: '', position: '', notes: '' };

export default function ShiftsPage() {
  const [weekStart, setWeekStart] = useState(''); const [shifts, setShifts] = useState<Shift[]>([]); const [employees, setEmployees] = useState<Employee[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [userUnitId, setUserUnitId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm); const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function loadShifts(start: string) {
    try {
      const query = `from=${encodeURIComponent(parseDate(start).toISOString())}&to=${encodeURIComponent(parseDate(addDays(start, 7)).toISOString())}`;
      setShifts((await api<ListResponse<Shift>>(`/shifts?${query}`)).items); setWeekStart(start);
    } catch (e) { fail(e, 'Erro ao carregar escalas'); }
  }
  async function load() {
    try {
      const [people, unitList] = await Promise.all([api<ListResponse<Employee>>('/employees'), api<ListResponse<Unit>>('/units')]);
      setEmployees(people.items.filter(person => person.status === 'ACTIVE')); setUnits(unitList.items); setUserUnitId(storedUser().unitId ?? null);
    } catch (e) { fail(e, 'Erro ao carregar funcionários'); }
    await loadShifts(weekStart || mondayOf(new Date()));
  }
  useAutoLoad(load);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try {
      if (editingId) await api(`/shifts/${editingId}`, { method: 'PATCH', body: JSON.stringify({ startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt), position: form.position || undefined, notes: form.notes || undefined }) });
      else await api('/shifts', { method: 'POST', body: JSON.stringify({ employeeId: form.employeeId, unitId: userUnitId ? undefined : form.unitId || undefined, startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt), position: form.position || undefined, notes: form.notes || undefined }) });
      ok(editingId ? 'Escala atualizada.' : 'Escala criada.'); setEditingId(null); setForm({ ...emptyForm, unitId: form.unitId }); await loadShifts(weekStart);
    } catch (e) { fail(e, 'Erro ao salvar escala'); }
  }
  async function remove(shift: Shift) {
    if (!window.confirm(`Excluir a escala de ${shift.employee?.fullName ?? 'funcionário'} em ${new Date(shift.startsAt).toLocaleDateString('pt-BR')}?`)) return;
    try { await api(`/shifts/${shift.id}`, { method: 'DELETE' }); ok('Escala excluída.'); if (editingId === shift.id) { setEditingId(null); setForm(emptyForm); } await loadShifts(weekStart); } catch (e) { fail(e, 'Erro ao excluir escala'); }
  }
  function startEdit(shift: Shift) { setEditingId(shift.id); setForm({ employeeId: shift.employeeId, unitId: shift.unitId, startsAt: toLocalInput(shift.startsAt), endsAt: toLocalInput(shift.endsAt), position: shift.position ?? '', notes: shift.notes ?? '' }); }

  const days = weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : [];
  const people = Array.from(new Map(shifts.map(shift => [shift.employeeId, shift.employee?.fullName ?? 'Funcionário'] as [string, string])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const shiftsFor = (employeeId: string, day: string) => shifts.filter(shift => shift.employeeId === employeeId && dateStr(new Date(shift.startsAt)) === day);

  return <AppShell title="Escalas">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{editingId ? 'Editar escala' : 'Nova escala'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-3">
        <Select label="Funcionário" required disabled={!!editingId} value={form.employeeId} onChange={e => { const person = employees.find(item => item.id === e.target.value); setForm({ ...form, employeeId: e.target.value, position: form.position || person?.position || '', unitId: person?.unitId || form.unitId }); }}><option value="">Selecione</option>{employees.map(person => <option key={person.id} value={person.id}>{person.fullName}</option>)}</Select>
        {!userUnitId && <Select label="Unidade" required disabled={!!editingId} value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>}
        <Field label="Cargo / função" maxLength={100} value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} />
        <Field label="Início" type="datetime-local" required value={form.startsAt} onChange={e => setForm({ ...form, startsAt: e.target.value })} />
        <Field label="Fim (máx. 16 h)" type="datetime-local" required min={form.startsAt || undefined} value={form.endsAt} onChange={e => setForm({ ...form, endsAt: e.target.value })} />
        <Field label="Observações" maxLength={300} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        <div className="flex items-end gap-2"><button className={buttonClass}>{editingId ? 'Salvar escala' : 'Criar escala'}</button>{editingId && <button type="button" className={secondaryButtonClass} onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancelar</button>}</div>
      </form></section>

    <section className={panelClass}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Semana de {weekStart ? `${parseDate(weekStart).toLocaleDateString('pt-BR')} a ${parseDate(addDays(weekStart, 6)).toLocaleDateString('pt-BR')}` : '…'}</h2><div className="flex gap-2"><button className={secondaryButtonClass} disabled={!weekStart} onClick={() => void loadShifts(addDays(weekStart, -7))}>← Anterior</button><button className={secondaryButtonClass} onClick={() => void loadShifts(mondayOf(new Date()))}>Esta semana</button><button className={secondaryButtonClass} disabled={!weekStart} onClick={() => void loadShifts(addDays(weekStart, 7))}>Próxima →</button></div></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[56rem] table-fixed border-collapse text-sm"><thead className="text-left text-slate-400"><tr><th className="w-40 p-2">Funcionário</th>{days.map((day, i) => <th key={day} className="p-2">{weekdays[i]} {parseDate(day).getDate()}/{parseDate(day).getMonth() + 1}</th>)}</tr></thead><tbody>{people.map(([employeeId, name]) => <tr key={employeeId} className="border-t border-slate-800 align-top"><td className="p-2 font-medium">{name}</td>{days.map(day => <td key={day} className="p-2">{shiftsFor(employeeId, day).map(shift => <div key={shift.id} className="mb-2 rounded-lg border border-slate-700 bg-slate-950 p-2"><div className="font-semibold">{time(shift.startsAt)}–{time(shift.endsAt)}</div>{shift.position && <div className="text-xs text-slate-400">{shift.position}</div>}{shift.notes && <div className="text-xs text-slate-500">{shift.notes}</div>}<div className="mt-1 flex gap-2 text-xs"><button className="text-blue-300 hover:text-white" onClick={() => startEdit(shift)}>Editar</button><button className="text-red-300 hover:text-white" onClick={() => void remove(shift)}>Excluir</button></div></div>)}</td>)}</tr>)}</tbody></table>{people.length === 0 && <p className="p-4 text-slate-400">Nenhuma escala nesta semana.</p>}</div>
    </section>
  </AppShell>;
}
