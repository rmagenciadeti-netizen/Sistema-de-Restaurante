'use client';

import { formatMoney, ModifierGroupView } from '../lib/api';

export type ModifierSelection = Record<string, number>;

const groupCount = (group: ModifierGroupView, selection: ModifierSelection) => group.options.reduce((sum, option) => sum + (selection[option.id] ?? 0), 0);

export function selectionError(groups: ModifierGroupView[], selection: ModifierSelection): string | null {
  for (const group of groups) {
    const count = groupCount(group, selection);
    if (count < group.minSelect) return `Escolha ao menos ${group.minSelect} opção(ões) em “${group.name}”.`;
    if (count > group.maxSelect) return `Escolha no máximo ${group.maxSelect} opção(ões) em “${group.name}”.`;
  }
  return null;
}

export const modifiersPayload = (selection: ModifierSelection) => Object.entries(selection).filter(([, quantity]) => quantity > 0).map(([optionId, quantity]) => ({ optionId, quantity }));
export const modifiersUnitTotal = (groups: ModifierGroupView[], selection: ModifierSelection) => groups.reduce((sum, group) => sum + group.options.reduce((inner, option) => inner + Number(option.price) * (selection[option.id] ?? 0), 0), 0);

export function ModifierPicker({ groups, value, onChange, large = false }: { groups: ModifierGroupView[]; value: ModifierSelection; onChange: (next: ModifierSelection) => void; large?: boolean }) {
  function setOption(group: ModifierGroupView, optionId: string, quantity: number) {
    const next = { ...value };
    if (group.maxSelect === 1) for (const option of group.options) delete next[option.id];
    if (quantity > 0) next[optionId] = quantity; else delete next[optionId];
    onChange(next);
  }
  const button = `${large ? 'h-9 w-9' : 'h-7 w-7'} rounded-lg border border-slate-700 disabled:opacity-30`;
  return <div className="mt-3 grid gap-3">{groups.map(group => {
    const count = groupCount(group, value);
    return <fieldset key={group.id} className="rounded-lg border border-slate-800 p-3"><legend className="px-1 text-sm font-semibold text-slate-200">{group.name} <span className="font-normal text-slate-400">({group.minSelect > 0 ? `obrigatório, ` : ''}{group.minSelect === group.maxSelect ? `escolha ${group.maxSelect}` : `${group.minSelect}–${group.maxSelect}`}) · {count} selecionado(s)</span></legend>
      <div className="grid gap-2">{group.options.map(option => {
        const quantity = value[option.id] ?? 0; const price = Number(option.price) > 0 ? `+ ${formatMoney(option.price)}` : '';
        return group.maxSelect === 1
          ? <label key={option.id} className="flex items-center justify-between gap-3 text-sm text-slate-300"><span className="flex items-center gap-2"><input type={group.minSelect === 0 ? 'checkbox' : 'radio'} name={`group-${group.id}`} className="h-4 w-4 accent-blue-600" checked={quantity > 0} onChange={e => setOption(group, option.id, e.target.checked ? 1 : 0)} />{option.name}</span><span className="text-slate-400">{price}</span></label>
          : <div key={option.id} className="flex items-center justify-between gap-3 text-sm text-slate-300"><span>{option.name} <span className="text-slate-400">{price}</span></span><span className="flex items-center gap-2"><button type="button" aria-label={`Remover ${option.name}`} className={button} disabled={quantity === 0} onClick={() => setOption(group, option.id, quantity - 1)}>−</button><span className="w-5 text-center">{quantity}</span><button type="button" aria-label={`Adicionar ${option.name}`} className={button} disabled={count >= group.maxSelect || quantity >= 20} onClick={() => setOption(group, option.id, quantity + 1)}>+</button></span></div>;
      })}</div></fieldset>;
  })}</div>;
}
