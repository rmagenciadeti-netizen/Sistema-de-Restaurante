'use client';

import QRCode from 'qrcode';
import { useState } from 'react';
import { api, errorMessage, ListResponse, RestaurantTable, storedUser, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const emptyForm = { label: '', seats: '4', unitId: '', active: true };

export default function TablesPage() {
  const [tables, setTables] = useState<RestaurantTable[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [userUnitId, setUserUnitId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm); const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [qr, setQr] = useState<{ table: RestaurantTable; url: string; image: string } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [list, unitList] = await Promise.all([api<ListResponse<RestaurantTable>>('/tables'), api<ListResponse<Unit>>('/units')]);
      setTables(list.items); setUnits(unitList.items); setUserUnitId(storedUser().unitId ?? null);
      setForm(current => current.unitId || !unitList.items[0] ? current : { ...current, unitId: unitList.items[0].id });
    } catch (e) { fail(e, 'Erro ao carregar mesas'); }
  }
  useAutoLoad(load);

  async function showQr(table: RestaurantTable) {
    const url = `${window.location.origin}/m/${table.qrToken}`;
    try { setQr({ table, url, image: await QRCode.toDataURL(url, { width: 360, margin: 2, errorCorrectionLevel: 'M' }) }); } catch (e) { fail(e, 'Erro ao gerar QR Code'); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const seats = Number(form.seats);
    try {
      if (editingId) await api(`/tables/${editingId}`, { method: 'PATCH', body: JSON.stringify({ label: form.label, seats, active: form.active }) });
      else await api('/tables', { method: 'POST', body: JSON.stringify({ label: form.label, seats, ...(userUnitId ? {} : { unitId: form.unitId }) }) });
      ok(editingId ? 'Mesa atualizada.' : 'Mesa cadastrada.'); setEditingId(null); setForm({ ...emptyForm, unitId: form.unitId }); await load();
    } catch (e) { fail(e, 'Erro ao salvar mesa'); }
  }
  async function rotate(table: RestaurantTable) {
    if (!window.confirm(`Girar o QR Code da mesa ${table.label}? O QR Code impresso atual deixará de funcionar.`)) return;
    try { const updated = await api<RestaurantTable>(`/tables/${table.id}/rotate-qr`, { method: 'POST' }); ok(`QR Code da mesa ${table.label} renovado. Imprima o novo código.`); await load(); if (qr?.table.id === table.id) await showQr(updated); } catch (e) { fail(e, 'Erro ao girar QR Code'); }
  }
  const unitName = (id: string) => units.find(unit => unit.id === id)?.name ?? '';

  return <AppShell title="Mesas e QR Code">
    <div className="print:hidden">{notice && <Notice message={notice.text} kind={notice.kind} />}</div>
    <section className={`${panelClass} mb-6 print:hidden`}><h2 className="mb-4 text-lg font-semibold">{editingId ? 'Editar mesa' : 'Nova mesa'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-4">
        <Field label="Identificação" required maxLength={30} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
        <Field label="Lugares" type="number" min="1" max="100" required value={form.seats} onChange={e => setForm({ ...form, seats: e.target.value })} />
        {!userUnitId && !editingId && <Select label="Unidade" required value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}><option value="">Selecione</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>}
        {editingId && <div className="flex items-end"><Check label="Mesa ativa" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /></div>}
        <div className="flex items-end gap-2"><button className={buttonClass}>{editingId ? 'Salvar' : 'Adicionar mesa'}</button>{editingId && <button type="button" className={secondaryButtonClass} onClick={() => { setEditingId(null); setForm({ ...emptyForm, unitId: form.unitId }); }}>Cancelar</button>}</div>
      </form></section>

    {qr && <section className={`${panelClass} mb-6 flex flex-col items-center gap-3 text-center print:m-0 print:border-0 print:bg-white print:p-0 print:text-black`}>
      <h2 className="text-2xl font-bold">Mesa {qr.table.label}</h2>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr.image} alt={`QR Code da mesa ${qr.table.label}`} className="h-72 w-72 rounded-lg bg-white print:h-[12cm] print:w-[12cm]" />
      <p className="max-w-sm text-sm text-slate-300 print:text-lg print:text-black">Aponte a câmera do celular para ver o cardápio e fazer seu pedido.</p>
      <p className="break-all text-xs text-slate-500 print:text-black">{qr.url}</p>
      <div className="flex gap-2 print:hidden"><button className={buttonClass} onClick={() => window.print()}>Imprimir QR</button><button className={secondaryButtonClass} onClick={() => setQr(null)}>Fechar</button></div>
    </section>}

    <section className={`${panelClass} print:hidden`}><h2 className="mb-4 text-lg font-semibold">Mesas ({tables.length})</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{tables.map(table => <article key={table.id} className="rounded-lg border border-slate-800 p-4"><h3 className="font-semibold">Mesa {table.label} {!table.active && <span className="text-xs text-red-300">inativa</span>}</h3><p className="mt-1 text-sm text-slate-400">{table.seats} lugares{units.length > 1 && unitName(table.unitId) ? ` · ${unitName(table.unitId)}` : ''}</p><div className="mt-3 flex flex-wrap gap-2"><button className={secondaryButtonClass} onClick={() => void showQr(table)}>Ver QR Code</button><button className={secondaryButtonClass} onClick={() => { setEditingId(table.id); setForm({ label: table.label, seats: String(table.seats), unitId: table.unitId, active: table.active }); }}>Editar</button><button className={secondaryButtonClass} onClick={() => void rotate(table)}>Girar QR</button></div></article>)}</div>{tables.length === 0 && <p className="text-slate-400">Nenhuma mesa cadastrada.</p>}</section>
  </AppShell>;
}
