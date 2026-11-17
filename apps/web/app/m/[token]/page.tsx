'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError, formatMoney, PublicMenu, PublicOrderResult, PublicProduct, publicApi } from '../../../lib/api';
import { useAutoLoad } from '../../../lib/use-auto-load';
import { ModifierPicker, ModifierSelection, modifiersPayload, modifiersUnitTotal, selectionError } from '../../../components/modifier-picker';

type CartLine = { quantity: number; notes: string; mods: ModifierSelection };
const MAX_QTY = 20;
const inputClass = 'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-blue-500';

function friendlyError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'QR Code inválido ou mesa indisponível. Chame um garçom.';
    if (error.status === 429) return 'Muitas solicitações ou pedidos em aberto nesta mesa. Aguarde um instante ou chame um garçom.';
    if (error.status === 400 && error.message === 'Validation failed') return 'Confira os dados informados e tente novamente.';
    return error.message;
  }
  return 'Não foi possível comunicar com o restaurante. Verifique sua conexão.';
}

export default function PublicMenuPage() {
  const { token } = useParams<{ token: string }>();
  const [menu, setMenu] = useState<PublicMenu | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false); const [confirmation, setConfirmation] = useState<PublicOrderResult | null>(null); const [formError, setFormError] = useState('');

  async function load() {
    try { setMenu(await publicApi<PublicMenu>(`/public/tables/${encodeURIComponent(token)}/menu`)); setError(''); } catch (e) { setError(friendlyError(e)); } finally { setLoading(false); }
  }
  useAutoLoad(load);

  const products = menu?.categories.flatMap(category => category.products) ?? [];
  const lines = products.filter(product => cart[product.id]?.quantity > 0);
  const unitPrice = (product: PublicProduct) => Number(product.price) + modifiersUnitTotal(product.modifierGroups ?? [], cart[product.id]?.mods ?? {});
  const subtotal = lines.reduce((sum, product) => sum + unitPrice(product) * cart[product.id].quantity, 0);
  const feePercent = Number(menu?.serviceFeePercent ?? 0);
  const serviceFee = Math.round(subtotal * feePercent) / 100;

  function setQuantity(productId: string, quantity: number) {
    setCart(current => {
      const next = { ...current }; const clamped = Math.max(0, Math.min(MAX_QTY, quantity));
      if (clamped === 0) delete next[productId]; else next[productId] = { quantity: clamped, notes: current[productId]?.notes ?? '', mods: current[productId]?.mods ?? {} };
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setFormError('');
    if (!lines.length) { setFormError('Adicione ao menos um item ao pedido.'); return; }
    for (const product of lines) { const problem = selectionError(product.modifierGroups ?? [], cart[product.id].mods); if (problem) { setFormError(`${product.name}: ${problem}`); return; } }
    if (phone.trim() && !name.trim()) { setFormError('Informe seu nome para registrar o telefone.'); return; }
    setBusy(true);
    try {
      const hasContact = name.trim().length > 0;
      const result = await publicApi<PublicOrderResult>(`/public/tables/${encodeURIComponent(token)}/orders`, { method: 'POST', body: JSON.stringify({
        customerName: hasContact ? name.trim() : undefined, customerPhone: hasContact && phone.trim() ? phone.trim() : undefined, marketingConsent: hasContact && phone.trim() ? consent : undefined,
        items: lines.map(product => ({ productId: product.id, quantity: cart[product.id].quantity, notes: cart[product.id].notes.trim() || undefined, modifiers: modifiersPayload(cart[product.id].mods).length ? modifiersPayload(cart[product.id].mods) : undefined })),
      }) });
      setConfirmation(result); setCart({});
    } catch (e) { setFormError(friendlyError(e)); } finally { setBusy(false); }
  }

  if (loading) return <main className="grid min-h-screen place-items-center p-6 text-slate-300">Carregando cardápio...</main>;
  if (error || !menu) return <main className="grid min-h-screen place-items-center p-6"><div role="alert" className="max-w-sm rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-center text-red-200">{error || 'Cardápio indisponível.'}</div></main>;

  if (confirmation) return <main className="mx-auto grid min-h-screen max-w-md place-items-center p-6"><div role="status" className="w-full rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 text-center"><p className="text-sm uppercase tracking-widest text-emerald-300">Pedido enviado</p><h1 className="mt-3 text-4xl font-bold text-white">{confirmation.code}</h1><p className="mt-3 text-slate-200">Mesa {menu.table} · {menu.restaurant}</p><p className="mt-4 text-lg font-semibold">Total: {formatMoney(confirmation.total)}</p>{Number(confirmation.serviceFee) > 0 && <p className="text-sm text-slate-300">Inclui taxa de serviço de {formatMoney(confirmation.serviceFee)}</p>}<p className="mt-4 text-sm text-slate-300">Seu pedido foi enviado para a cozinha. O pagamento é feito no atendimento.</p><button className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-500" onClick={() => setConfirmation(null)}>Fazer novo pedido</button></div></main>;

  return <main className="mx-auto max-w-2xl px-4 pb-10">
    <header className="sticky top-0 z-10 -mx-4 border-b border-slate-800 bg-slate-950/95 px-4 py-4 backdrop-blur"><p className="text-xs uppercase tracking-[0.25em] text-blue-400">{menu.restaurant}</p><h1 className="mt-1 text-xl font-bold text-white">Mesa {menu.table} <span className="text-sm font-normal text-slate-400">· {menu.unit}</span></h1></header>
    {menu.categories.length === 0 && <p className="mt-6 text-slate-400">Nenhum produto disponível no momento.</p>}
    {menu.categories.map(category => <section key={category.id ?? 'none'} className="mt-6"><h2 className="mb-3 text-lg font-semibold text-white">{category.name}</h2><div className="grid gap-3">{category.products.map(product => {
      const line = cart[product.id];
      return <article key={product.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{product.name}</h3>{product.description && <p className="mt-1 text-sm text-slate-400">{product.description}</p>}{product.isCombo && product.comboComponents && product.comboComponents.length > 0 && <p className="mt-1 text-sm text-blue-300">Combo inclui: {product.comboComponents.map(component => `${component.quantity}× ${component.product.name}`).join(', ')}</p>}<p className="mt-2 font-semibold text-blue-300">{formatMoney(product.price)}</p></div>
        <div className="flex shrink-0 items-center gap-2"><button type="button" aria-label={`Remover ${product.name}`} disabled={!line} className="h-10 w-10 rounded-lg border border-slate-700 text-xl disabled:opacity-30" onClick={() => setQuantity(product.id, (line?.quantity ?? 0) - 1)}>−</button><span className="w-6 text-center font-semibold">{line?.quantity ?? 0}</span><button type="button" aria-label={`Adicionar ${product.name}`} disabled={(line?.quantity ?? 0) >= MAX_QTY} className="h-10 w-10 rounded-lg bg-blue-600 text-xl text-white disabled:opacity-30" onClick={() => setQuantity(product.id, (line?.quantity ?? 0) + 1)}>+</button></div></div>
        {line && (product.modifierGroups?.length ?? 0) > 0 && <ModifierPicker large groups={product.modifierGroups ?? []} value={line.mods} onChange={mods => setCart(current => ({ ...current, [product.id]: { ...line, mods } }))} />}{line && <input aria-label={`Observação para ${product.name}`} maxLength={200} placeholder="Observação (ex.: sem cebola)" className={inputClass} value={line.notes} onChange={e => setCart(current => ({ ...current, [product.id]: { ...line, notes: e.target.value } }))} />}</article>;
    })}</div></section>)}

    <form onSubmit={submit} className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-lg font-semibold text-white">Seu pedido</h2>
      {lines.length === 0 ? <p className="mt-2 text-sm text-slate-400">Nenhum item selecionado.</p> : <ul className="mt-3 grid gap-1 text-sm">{lines.map(product => <li key={product.id} className="flex justify-between gap-3"><span>{cart[product.id].quantity}× {product.name}{(product.modifierGroups ?? []).flatMap(group => group.options).filter(option => cart[product.id].mods[option.id]).map(option => ` + ${cart[product.id].mods[option.id]}× ${option.name}`).join('')}</span><span>{formatMoney(unitPrice(product) * cart[product.id].quantity)}</span></li>)}</ul>}
      <div className="mt-4 grid gap-1 border-t border-slate-800 pt-3 text-sm"><div className="flex justify-between"><span className="text-slate-400">Subtotal</span><span>{formatMoney(subtotal)}</span></div>{feePercent > 0 && <div className="flex justify-between"><span className="text-slate-400">Taxa de serviço estimada ({feePercent}%)</span><span>{formatMoney(serviceFee)}</span></div>}<div className="flex justify-between text-base font-semibold"><span>Total estimado</span><span>{formatMoney(subtotal + serviceFee)}</span></div></div>
      <fieldset className="mt-5 grid gap-3"><legend className="text-sm font-semibold text-slate-200">Identificação (opcional)</legend>
        <label className="block text-sm text-slate-300">Nome<input className={inputClass} maxLength={160} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="block text-sm text-slate-300">Telefone / WhatsApp<input className={inputClass} type="tel" maxLength={30} autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
        <label className="flex items-start gap-3 text-xs text-slate-400"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Aceito receber promoções e novidades de {menu.restaurant} por WhatsApp. Seus dados (nome e telefone) são usados para identificar seu pedido e, somente com este consentimento, para comunicações de marketing, conforme a LGPD. Você pode revogar o consentimento a qualquer momento solicitando ao restaurante.</span></label>
      </fieldset>
      {formError && <div role="alert" className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{formError}</div>}
      <button disabled={busy || lines.length === 0} className="mt-5 w-full rounded-xl bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{busy ? 'Enviando...' : `Enviar pedido · ${formatMoney(subtotal + serviceFee)}`}</button>
      <p className="mt-3 text-center text-xs text-slate-500">O valor final e o pagamento são confirmados no atendimento.</p>
    </form>
  </main>;
}
