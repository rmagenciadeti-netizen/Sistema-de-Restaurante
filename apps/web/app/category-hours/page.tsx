'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import type { CategorySchedule, ScheduleWindow } from '../../lib/types-catalog';
import { AppShell, buttonClass, Notice, secondaryButtonClass } from '../../components/app-shell';
import { Badge, EmptyState, PageHeader, SideTabs } from '../../components/ui';

const DAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
type DraftWindow = { weekday: number; start: string; end: string };

const toTime = (minutes: number) => `${String(Math.floor(Math.min(minutes, 1439) / 60)).padStart(2, '0')}:${String(Math.min(minutes, 1439) % 60).padStart(2, '0')}`;
const toMinutes = (time: string) => { const [hours, minutes] = time.split(':').map(Number); return hours * 60 + minutes; };
const toDraft = (windows: ScheduleWindow[]): DraftWindow[] => windows.map(window => ({ weekday: window.weekday, start: toTime(window.startMinute), end: toTime(window.endMinute) }));

export default function CategoryHoursPage() {
  const [schedules, setSchedules] = useState<CategorySchedule[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<DraftWindow[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(keep = selected) {
    try {
      const items = (await api<ListResponse<CategorySchedule>>('/category-schedules')).items;
      setSchedules(items);
      const current = items.find(item => item.categoryId === keep) ?? items[0];
      if (current) { setSelected(current.categoryId); setDraft(toDraft(current.windows)); }
    } catch (e) { fail(e, 'Erro ao carregar horários das categorias'); }
  }
  useAutoLoad(() => load());

  function select(categoryId: string) {
    const target = schedules.find(item => item.categoryId === categoryId);
    setSelected(categoryId); setDraft(toDraft(target?.windows ?? [])); setNotice(null);
  }
  const update = (index: number, patch: Partial<DraftWindow>) => setDraft(current => current.map((window, position) => (position === index ? { ...window, ...patch } : window)));
  const addWindow = (weekday: number) => setDraft(current => [...current, { weekday, start: '11:00', end: '15:00' }]);
  const removeWindow = (index: number) => setDraft(current => current.filter((_, position) => position !== index));
  const allDay = (weekday: number) => setDraft(current => [...current.filter(window => window.weekday !== weekday), { weekday, start: '00:00', end: '23:59' }]);
  function copyDay(weekday: number) {
    const source = draft.filter(window => window.weekday === weekday);
    setDraft([...source, ...[0, 1, 2, 3, 4, 5, 6].filter(day => day !== weekday).flatMap(day => source.map(window => ({ ...window, weekday: day })))]);
    setNotice({ text: `Horários de ${DAYS[weekday].toLowerCase()} copiados para os demais dias. Salve para aplicar.`, kind: 'success' });
  }

  async function save() {
    setNotice(null);
    const windows = draft.map(window => ({ weekday: window.weekday, startMinute: toMinutes(window.start), endMinute: toMinutes(window.end) }));
    const invalid = draft.find((window, index) => !window.start || !window.end || windows[index].startMinute >= windows[index].endMinute);
    if (invalid) { setNotice({ text: `Em ${DAYS[invalid.weekday].toLowerCase()}, o horário inicial deve ser anterior ao final.`, kind: 'error' }); return; }
    setSaving(true);
    try {
      await api(`/category-schedules/${selected}`, { method: 'PUT', body: JSON.stringify({ windows }) });
      setNotice({ text: 'Horários salvos.', kind: 'success' });
      await load(selected);
    } catch (e) { fail(e, 'Erro ao salvar horários'); }
    finally { setSaving(false); }
  }

  const current = schedules.find(item => item.categoryId === selected);

  return <AppShell title="Exibição das categorias">
    <PageHeader title="Gestão de exibição das categorias" subtitle="Defina em quais dias e horários cada categoria aparece no cardápio das mesas. Categoria sem horários fica sempre visível. Os horários seguem o fuso das configurações do restaurante." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {schedules.length === 0 ? <EmptyState icon="🕒" title="Nenhuma categoria cadastrada" hint="Crie categorias em Produtos › Categorias para controlar o horário de exibição." />
      : <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <SideTabs tabs={schedules.map(item => ({ key: item.categoryId, label: item.categoryName }))} value={selected} onChange={select} />
        <section className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold">{current?.categoryName}</h2><p className="mt-1">{draft.length === 0 ? <Badge tone="green">Sempre visível</Badge> : <Badge tone="gold">{draft.length} horário(s) definido(s)</Badge>}</p></div>
            <div className="flex gap-2"><button type="button" className={secondaryButtonClass} disabled={draft.length === 0} onClick={() => setDraft([])}>Limpar (sempre visível)</button><button type="button" className={buttonClass} disabled={saving} onClick={() => void save()}>{saving ? 'Salvando...' : 'Salvar horários'}</button></div>
          </div>
          <ul className="divide-y divide-slate-100">
            {DAYS.map((day, weekday) => {
              const rows = draft.map((window, index) => ({ window, index })).filter(row => row.window.weekday === weekday);
              return <li key={day} className="grid gap-2 py-3 sm:grid-cols-[9rem_1fr]">
                <p className="text-sm font-semibold text-slate-800">{day}</p>
                <div className="space-y-2">
                  {rows.length === 0 && draft.length > 0 && <p className="text-sm text-slate-500">Oculta neste dia.</p>}
                  {rows.length === 0 && draft.length === 0 && <p className="text-sm text-slate-500">Sempre visível.</p>}
                  {rows.map(({ window, index }) => <div key={index} className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-slate-600">Das<input type="time" required className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={window.start} onChange={e => update(index, { start: e.target.value })} /></label>
                    <label className="text-xs text-slate-600">às<input type="time" required className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={window.end} onChange={e => update(index, { end: e.target.value })} /></label>
                    <button type="button" className="text-sm font-medium text-red-700 hover:underline" aria-label={`Remover horário de ${day}`} onClick={() => removeWindow(index)}>Remover</button>
                  </div>)}
                  <div className="flex flex-wrap gap-3 text-sm">
                    <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => addWindow(weekday)}>+ Adicionar horário</button>
                    <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => allDay(weekday)}>Dia todo</button>
                    {rows.length > 0 && <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => copyDay(weekday)}>Copiar para todos os dias</button>}
                  </div>
                </div>
              </li>;
            })}
          </ul>
        </section>
      </div>}
  </AppShell>;
}
