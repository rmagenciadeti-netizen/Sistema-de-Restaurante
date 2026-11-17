'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, errorMessage, formatDateTime, ListResponse, Reservation, RestaurantTable, storedUser, toIso, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const statusLabel: Record<string, string> = { PENDING: 'Pendente', CONFIRMED: 'Confirmada', SEATED: 'Sentada', CANCELLED: 'Cancelada', NO_SHOW: 'Não compareceu' };
const actions: { status: string; label: string; from: string[] }[] = [
  { status: 'CONFIRMED', label: 'Confirmar', from: ['PENDING'] },
  { status: 'SEATED', label: 'Sentar', from: ['PENDING', 'CONFIRMED'] },
  { status: 'CANCELLED', label: 'Cancelar', from: ['PENDING', 'CONFIRMED', 'SEATED'] },
  { status: 'NO_SHOW', label: 'Não compareceu', from: ['PENDING', 'CONFIRMED'] },
];
const emptyForm = { unitId: '', tableId: '', customerName: '', phone: '', partySize: '2', reservedAt: '', notes: '' };

export default function ReservationsPage() {
  const [items, setItems] = useState<Reservation[]>([]); const [tables, setTables] = useState<RestaurantTable[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [userUnitId, setUserUnitId] = useState<string | null>(null);
  const [date, setDate] = useState(''); const [form, setForm] = useState(emptyForm);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function loadReservations(day = date) {
    try { setItems((await api<ListResponse<Reservation>>(`/reservations${day ? `?date=${day}` : ''}`)).items); } catch (e) { fail(e, 'Erro ao carregar reservas'); }
  }
  async function load() {
    try {
      const [t, u] = await Promise.all([api<ListResponse<RestaurantTable>>('/tables'), api<ListResponse<Unit>>('/units')]);
      setTables(t.items.filter(table => table.active)); setUnits(u.items); setUserUnitId(storedUser().unitId ?? null);
      setForm(current => current.unitId || !u.items[0] ? current : { ...current, unitId: u.items[0].id });
    } catch (e) { fail(e, 'Erro ao carregar mesas e unidades'); }
    await loadReservations();
  }
  useAutoLoad(load);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const body = { unitId: userUnitId ? undefined : form.unitId || undefined, tableId: form.tableId || undefined, customerName: form.customerName, phone: form.phone || undefined, partySize: Number(form.partySize), reservedAt: toIso(form.reservedAt), notes: form.notes || undefined };
    try { await api('/reservations', { method: 'POST', body: JSON.stringify(body) }); setNotice({ text: 'Reserva criada.', kind: 'success' }); setForm({ ...emptyForm, unitId: form.unitId }); await loadReservations(); } catch (e) { fail(e, 'Erro ao criar reserva'); }
  }
  async function changeStatus(item: Reservation, status: string) {
    setNotice(null);
    try { await api(`/reservations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadReservations(); } catch (e) { fail(e, 'Erro ao atualizar reserva'); }
  }
  const unitTables = tables.filter(table => !form.unitId || table.unitId === form.unitId);

  return <AppShell title="Reservas">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Nova reserva</h2>
      <form onSubmit={create} className="grid gap-4 md:grid-cols-3">
        {!userUnitId && <Select label="Unidade" required value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value, tableId: '' })}><option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>}
        <Select label="Mesa (opcional)" value={form.tableId} onChange={e => setForm({ ...form, tableId: e.target.value })}><option value="">Sem mesa definida</option>{unitTables.map(table => <option key={table.id} value={table.id}>Mesa {table.label} ({table.seats} lugares)</option>)}</Select>
        <Field label="Nome do cliente" required minLength={2} maxLength={160} value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })} />
        <Field label="Telefone" maxLength={30} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Field label="Pessoas" type="number" min="1" max="500" required value={form.partySize} onChange={e => setForm({ ...form, partySize: e.target.value })} />
        <Field label="Data e hora" type="datetime-local" required value={form.reservedAt} onChange={e => setForm({ ...form, reservedAt: e.target.value })} />
        <Field label="Observações" maxLength={500} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        <div className="flex items-end"><button className={buttonClass}>Reservar</button></div>
      </form></section>
    <section className={panelClass}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><h2 className="text-lg font-semibold">{date ? `Reservas de ${date.split('-').reverse().join('/')}` : 'Próximas reservas'} ({items.length})</h2><div className="flex items-end gap-2"><Field label="Data" type="date" value={date} onChange={e => { setDate(e.target.value); void loadReservations(e.target.value); }} />{date && <button className={secondaryButtonClass} onClick={() => { setDate(''); void loadReservations(''); }}>Limpar filtro</button>}</div></div>
      <div className="grid gap-3">{items.map(item => <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">{formatDateTime(item.reservedAt)}</p><h3 className="mt-1 text-lg font-semibold">{item.customerName} · {item.partySize} pessoa(s)</h3><p className="mt-1 text-sm text-slate-500">{item.table ? `Mesa ${item.table.label}` : 'Sem mesa'}{item.phone ? ` · ${item.phone}` : ''} · {statusLabel[item.status]}</p>{item.notes && <p className="mt-1 text-sm text-slate-300">{item.notes}</p>}</div><div className="flex flex-wrap gap-2">{item.status === 'SEATED' && item.tableId && tables.some(table => table.id === item.tableId) && <Link href={`/orders?tableId=${encodeURIComponent(item.tableId)}`} className={buttonClass}>Abrir pedido da mesa</Link>}{actions.filter(action => action.from.includes(item.status)).map(action => <button key={action.status} className={secondaryButtonClass} onClick={() => void changeStatus(item, action.status)}>{action.label}</button>)}</div></div></article>)}</div>
      {items.length === 0 && <p className="text-slate-400">Nenhuma reserva encontrada.</p>}
    </section>
  </AppShell>;
}
