'use client';

import { useState } from 'react';
import { weekdayNames, type Slot } from '../lib/settings';
import { replaceDaySlots, slotsOfDay, slotSummary } from '../lib/settings-helpers';
import { inputClass, secondaryButtonClass } from './app-shell';
import { dangerButtonClass } from './ui';

const dayColors = ['bg-rose-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500', 'bg-teal-500', 'bg-orange-700'];

// Seven expandable rows (one per weekday); each row edits that day's time ranges.
export function WeekSlots({ slots, onChange, disabled = false, defaultOpen = false }: { slots: Slot[]; onChange: (slots: Slot[]) => void; disabled?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState<number[]>(defaultOpen ? [0, 1, 2, 3, 4, 5, 6] : []);
  const toggle = (day: number) => setOpen(current => (current.includes(day) ? current.filter(item => item !== day) : [...current, day]));

  return <ul className="space-y-2">
    {weekdayNames.map((name, day) => {
      const daySlots = slotsOfDay(slots, day); const expanded = open.includes(day);
      const update = (next: Slot[]) => onChange(replaceDaySlots(slots, day, next));
      return <li key={day} className="rounded-xl border border-slate-200 bg-white">
        <button type="button" aria-expanded={expanded} aria-controls={`day-${day}`} onClick={() => toggle(day)} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-slate-50">
          <span aria-hidden="true" className={`h-8 w-1.5 shrink-0 rounded-full ${dayColors[day]}`} />
          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-900">{name}</span><span className="block truncate text-xs text-slate-500">{slotSummary(daySlots)}</span></span>
          <span aria-hidden="true" className="text-slate-400">{expanded ? '▴' : '▾'}</span>
        </button>
        {expanded && <div id={`day-${day}`} className="space-y-2 border-t border-slate-100 px-4 py-3">
          {daySlots.length === 0 && <p className="text-sm text-slate-500">Nenhuma faixa de horário neste dia.</p>}
          {daySlots.map((slot, index) => {
            const invalid = slot.start >= slot.end;
            return <div key={index} className="flex flex-wrap items-end gap-2">
              <label className="text-sm text-slate-700">Das<input type="time" value={slot.start} disabled={disabled} onChange={event => update(daySlots.map((item, i) => (i === index ? { ...item, start: event.target.value } : item)))} className={`${inputClass} w-32`} aria-invalid={invalid} /></label>
              <label className="text-sm text-slate-700">Até<input type="time" value={slot.end} disabled={disabled} onChange={event => update(daySlots.map((item, i) => (i === index ? { ...item, end: event.target.value } : item)))} className={`${inputClass} w-32`} aria-invalid={invalid} /></label>
              <button type="button" disabled={disabled} onClick={() => update(daySlots.filter((_, i) => i !== index))} className={dangerButtonClass} aria-label={`Remover faixa ${slot.start}–${slot.end} de ${name}`}>Remover</button>
              {invalid && <span role="alert" className="text-xs text-red-700">O início deve ser anterior ao fim.</span>}
            </div>;
          })}
          <button type="button" disabled={disabled || daySlots.length >= 10} onClick={() => update([...daySlots, { day, start: daySlots.length ? daySlots[daySlots.length - 1].end : '09:00', end: '23:00' }])} className={secondaryButtonClass}>+ Adicionar faixa</button>
        </div>}
      </li>;
    })}
  </ul>;
}
