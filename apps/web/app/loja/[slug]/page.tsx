'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, formatMoney, publicApi } from '../../../lib/api';
import { weekdayNames } from '../../../lib/settings';
import type { StoreData, StoreOrderResult, StoreProduct } from '../../../lib/types-store';
import { useAutoLoad } from '../../../lib/use-auto-load';
import { ModifierPicker, ModifierSelection, modifiersPayload, modifiersUnitTotal, selectionError } from '../../../components/modifier-picker';

declare global { interface Window { fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; callMethod?: (...args: unknown[]) => void } } }

// Loads the Meta Pixel for the store; the id is validated server-side and re-checked here so it can never inject script content.
function loadMetaPixel(pixelId: string) {
  if (!/^\d{8,20}$/.test(pixelId) || window.fbq) return;
  const fbq = ((...args: unknown[]) => { if (fbq.callMethod) fbq.callMethod(...args); else (fbq.queue ??= []).push(args); }) as NonNullable<Window['fbq']>;
  fbq.queue = []; fbq.loaded = true; window.fbq = fbq;
  const script = document.createElement('script'); script.async = true; script.src = 'https://connect.facebook.net/en_US/fbevents.js'; document.head.appendChild(script);
  fbq('init', pixelId); fbq('track', 'PageView');
}

type Line = { quantity: number; weight: string; notes: string; mods: ModifierSelection };
type Fulfillment = 'TAKEAWAY' | 'DELIVERY';

const MAX_QTY = 20;
const field = 'mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-3 text-base text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20';
const round2 = (value: number) => Math.round(value * 100) / 100;
const parseWeight = (value: string) => { const parsed = Number(value.replace(',', '.')); return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0; };
const validWeight = (value: string) => { const weight = parseWeight(value); return weight > 0 && weight <= 999.999; };
const pad = (value: number) => String(value).padStart(2, '0');
const localInput = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const shortDay = (day: number) => weekdayNames[day].slice(0, 3);

// Weekday, minutes since midnight and ISO day of an instant as seen in the restaurant's time zone (same rule the API applies).
function storeParts(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')), day: `${get('year')}-${get('month')}-${get('day')}` };
  } catch { return { weekday: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes(), day: localInput(date).slice(0, 10) }; }
}

function weeklyText(slots: { day: number; start: string; end: string }[]) {
  const byDay = new Map<number, string[]>();
  for (const slot of [...slots].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))) byDay.set(slot.day, [...(byDay.get(slot.day) ?? []), `${slot.start}–${slot.end}`]);
  return Array.from(byDay.entries()).map(([day, ranges]) => `${shortDay(day)} ${ranges.join(', ')}`);
}

const ERRORS: Record<string, string> = {
  STORE_CLOSED: 'A loja está fechada no momento. Se o agendamento estiver disponível, escolha uma data e horário.',
  PRODUCTS_UNAVAILABLE: 'Algum item do pedido não está mais disponível. Atualize a página e confira o cardápio.',
  COUPON_UNAVAILABLE: 'Cupom inválido, expirado ou indisponível para este pedido.',
  INVALID_PHONE: 'Informe um telefone válido com DDD.',
  BELOW_DELIVERY_MINIMUM: 'O pedido não atinge o valor mínimo para entrega.',
  DELIVERY_ZONE_REQUIRED: 'Escolha a região de entrega.',
  DELIVERY_ZONE_UNAVAILABLE: 'A região de entrega escolhida não está disponível.',
  ADDRESS_REQUIRED: 'Informe o endereço de entrega.',
  WEIGHT_REQUIRED: 'Informe o peso (kg) dos produtos vendidos por quilo.',
  WEIGHT_NOT_ALLOWED: 'Um dos itens não é vendido por peso. Atualize a página.',
  MODIFIER_UNAVAILABLE: 'Uma opção escolhida não está mais disponível.',
  MODIFIER_SELECTION_INVALID: 'Confira as opções obrigatórias dos itens.',
  FULFILLMENT_NOT_ALLOWED: 'Este tipo de atendimento não está disponível.',
  PAYMENT_METHOD_UNAVAILABLE: 'A forma de pagamento escolhida não está disponível.',
  SCHEDULING_DISABLED: 'Esta loja não aceita pedidos agendados.',
  SCHEDULE_TOO_SOON: 'Escolha um horário com mais antecedência.',
  SCHEDULE_TOO_FAR: 'O horário escolhido está distante demais.',
  SCHEDULE_BLOCKED: 'Não aceitamos agendamentos nesta data.',
  SCHEDULE_OUTSIDE_SLOTS: 'O horário escolhido está fora das faixas de agendamento.',
};

function scheduleProblem(store: StoreData, scheduledAt: string): string {
  const now = Date.now();
  if (!scheduledAt) return 'Escolha a data e o horário do agendamento.';
  const date = new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) return 'Data e horário inválidos.';
  const { scheduling: rules, hours } = store;
  if (date.getTime() < now + 5 * 60_000) return ERRORS.SCHEDULE_TOO_SOON;
  if (date.getTime() > now + (rules.maxDaysAhead > 0 ? rules.maxDaysAhead : 30) * 86_400_000) return ERRORS.SCHEDULE_TOO_FAR;
  const local = storeParts(date, hours.timezone);
  if (rules.blockedFrom && rules.blockedTo && local.day >= rules.blockedFrom && local.day <= rules.blockedTo) return ERRORS.SCHEDULE_BLOCKED;
  if (rules.slots.length > 0 && !rules.slots.some(slot => slot.day === local.weekday && local.minutes >= minutesOf(slot.start) && local.minutes <= minutesOf(slot.end))) return ERRORS.SCHEDULE_OUTSIDE_SLOTS;
  return '';
}

function friendly(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Loja não encontrada ou indisponível.';
    if (error.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (error.message === 'Validation failed') return 'Confira os dados informados e tente novamente.';
    return ERRORS[error.message] ?? error.message;
  }
  return 'Não foi possível comunicar com o restaurante. Verifique sua conexão.';
}

export default function StorePage() {
  const { slug } = useParams<{ slug: string }>();
  const [store, setStore] = useState<StoreData | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<Record<string, Line>>({});
  const [search, setSearch] = useState('');
  const [fulfillment, setFulfillment] = useState<Fulfillment | null>(null); const [zoneId, setZoneId] = useState(''); const [address, setAddress] = useState('');
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [coupon, setCoupon] = useState(''); const [notes, setNotes] = useState('');
  const [schedule, setSchedule] = useState(false); const [scheduledAt, setScheduledAt] = useState('');
  const [paymentId, setPaymentId] = useState(''); const [changeFor, setChangeFor] = useState('');
  const [loadedAt, setLoadedAt] = useState(0);
  const [busy, setBusy] = useState(false); const [formError, setFormError] = useState(''); const [confirmation, setConfirmation] = useState<StoreOrderResult | null>(null);

  async function load() {
    try { setStore(await publicApi<StoreData>(`/public/store/${encodeURIComponent(slug)}`)); setLoadedAt(Date.now()); setError(''); } catch (e) { setError(friendly(e)); } finally { setLoading(false); }
  }
  useAutoLoad(load);

  const pixelId = store?.metaPixelId ?? null;
  useEffect(() => { if (pixelId) loadMetaPixel(pixelId); }, [pixelId]);

  const products = useMemo(() => store?.categories.flatMap(category => category.products) ?? [], [store]);
  const lines = products.filter(product => cart[product.id]);
  const accent = store?.brandColor ?? '#b89235';
  const fulfil = store?.fulfillment;
  const channel: Fulfillment | null = fulfillment ?? (fulfil?.allowPickup ? 'TAKEAWAY' : fulfil?.allowDelivery ? 'DELIVERY' : null);
  const closedOnly = Boolean(store && !store.open && !store.allowBuyWhenClosed);
  const canSchedule = Boolean(store?.scheduling.enabled);
  const scheduling = canSchedule && (schedule || closedOnly);

  const unitPrice = (product: StoreProduct, line: Line) => {
    const price = Number(product.promoPrice ?? product.price);
    return (product.soldByWeight ? round2(price * parseWeight(line.weight)) : price) + modifiersUnitTotal(product.modifierGroups ?? [], line.mods);
  };
  const subtotal = round2(lines.reduce((sum, product) => sum + unitPrice(product, cart[product.id]) * cart[product.id].quantity, 0));
  const zone = store?.deliveryZones.find(entry => entry.id === zoneId);
  const usesZones = Boolean(store && store.deliveryZones.length > 0 && (store.fulfillment.deliveryFeeMode === 'ZONES' || store.fulfillment.deliveryFeeMode === 'DISTRICT' || zoneId));
  const baseFee = channel !== 'DELIVERY' ? 0 : usesZones ? Number(zone?.fee ?? 0) : Number(fulfil?.singleFee ?? 0);
  const deliveryFee = fulfil && fulfil.freeDeliveryMin > 0 && subtotal >= fulfil.freeDeliveryMin ? 0 : baseFee;
  const total = round2(subtotal + deliveryFee);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (store?.categories ?? []).map(category => ({ ...category, products: term ? category.products.filter(product => `${product.name} ${product.description ?? ''}`.toLowerCase().includes(term)) : category.products })).filter(category => category.products.length > 0);
  }, [store, search]);

  function setQuantity(product: StoreProduct, quantity: number) {
    setCart(current => {
      const next = { ...current }; const clamped = Math.max(0, Math.min(MAX_QTY, quantity));
      if (clamped === 0) delete next[product.id]; else next[product.id] = { quantity: clamped, weight: current[product.id]?.weight ?? '', notes: current[product.id]?.notes ?? '', mods: current[product.id]?.mods ?? {} };
      return next;
    });
  }
  const patchLine = (id: string, change: Partial<Line>) => setCart(current => (current[id] ? { ...current, [id]: { ...current[id], ...change } } : current));

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setFormError('');
    if (!store || !channel) return;
    if (lines.length === 0) { setFormError('Adicione ao menos um item ao pedido.'); return; }
    for (const product of lines) {
      const line = cart[product.id];
      const problem = selectionError(product.modifierGroups ?? [], line.mods);
      if (problem) { setFormError(`${product.name}: ${problem}`); return; }
      if (product.soldByWeight && !validWeight(line.weight)) { setFormError(`${product.name}: informe o peso em kg (ex.: 0,350).`); return; }
    }
    if (channel === 'DELIVERY') {
      if (!address.trim()) { setFormError('Informe o endereço de entrega.'); return; }
      if (usesZones && !zone) { setFormError('Escolha a região de entrega.'); return; }
      if (store.fulfillment.minDelivery > 0 && subtotal < store.fulfillment.minDelivery) { setFormError(`Pedido mínimo para entrega: ${formatMoney(store.fulfillment.minDelivery)}.`); return; }
      if (zone?.minOrder && subtotal < Number(zone.minOrder)) { setFormError(`Pedido mínimo para ${zone.name}: ${formatMoney(zone.minOrder)}.`); return; }
    }
    if (!name.trim() || !phone.trim()) { setFormError('Informe seu nome e telefone.'); return; }
    if (closedOnly && !scheduling) { setFormError(ERRORS.STORE_CLOSED); return; }
    if (scheduling) { const problem = scheduleProblem(store, scheduledAt); if (problem) { setFormError(problem); return; } }
    const method = store.paymentMethods.find(entry => entry.id === paymentId);
    const change = Number(changeFor.replace(',', '.'));
    setBusy(true);
    try {
      const result = await publicApi<StoreOrderResult>(`/public/store/${encodeURIComponent(slug)}/orders`, { method: 'POST', body: JSON.stringify({
        fulfillment: channel, customer: { name: name.trim(), phone: phone.trim() },
        address: channel === 'DELIVERY' ? address.trim() : undefined, deliveryZoneId: channel === 'DELIVERY' && zone ? zone.id : undefined,
        couponCode: coupon.trim() || undefined, scheduledFor: scheduling ? new Date(scheduledAt).toISOString() : undefined, notes: notes.trim() || undefined,
        paymentMethodId: method?.id, changeFor: method?.allowChange && method.equivalent === 'CASH' && change > 0 ? change : undefined,
        items: lines.map(product => {
          const line = cart[product.id]; const mods = modifiersPayload(line.mods);
          return { productId: product.id, quantity: line.quantity, weightKg: product.soldByWeight ? parseWeight(line.weight) : undefined, notes: line.notes.trim() || undefined, modifiers: mods.length ? mods : undefined };
        }),
      }) });
      if (pixelId) window.fbq?.('track', 'Purchase', { value: Number(result.total), currency: 'BRL' });
      setConfirmation(result); setCart({});
    } catch (e) { setFormError(friendly(e)); } finally { setBusy(false); }
  }

  const shell = 'min-h-screen bg-neutral-950 text-neutral-100';
  if (loading) return <main className={`${shell} grid place-items-center p-6 text-neutral-400`}>Carregando cardápio...</main>;
  if (error || !store) return <main className={`${shell} grid place-items-center p-6`}><div role="alert" className="max-w-sm rounded-2xl border border-red-500/40 bg-red-950/40 p-6 text-center text-red-200">{error || 'Loja indisponível.'}</div></main>;

  if (confirmation) return <main className={`${shell} mx-auto grid max-w-md place-items-center p-6`}>
    <div role="status" className="w-full rounded-3xl border border-neutral-800 bg-neutral-900 p-7 text-center shadow-2xl">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full text-2xl text-neutral-950" style={{ background: accent }}>✓</span>
      <h1 className="mt-4 text-xl font-bold">{confirmation.scheduledFor ? 'Pedido agendado!' : 'Pedido recebido!'}</h1>
      <p className="mt-2 text-sm text-neutral-400">{store.restaurant.name}</p>
      <dl className="mt-5 grid gap-2 rounded-2xl bg-neutral-950 p-4 text-left text-sm">
        {confirmation.number !== null && <div className="flex justify-between"><dt className="text-neutral-400">Número</dt><dd className="font-bold">#{confirmation.number}</dd></div>}
        <div className="flex justify-between"><dt className="text-neutral-400">Código</dt><dd className="font-mono font-bold">{confirmation.code}</dd></div>
        {confirmation.scheduledFor && <div className="flex justify-between gap-3"><dt className="text-neutral-400">Agendado para</dt><dd className="text-right font-medium">{new Date(confirmation.scheduledFor).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</dd></div>}
        <div className="flex justify-between"><dt className="text-neutral-400">Total</dt><dd className="font-bold" style={{ color: accent }}>{formatMoney(confirmation.total)}</dd></div>
      </dl>
      <p className="mt-4 text-xs text-neutral-400">{confirmation.autoAccept ? 'Seu pedido foi enviado e será aceito automaticamente.' : 'O restaurante vai confirmar seu pedido em instantes.'} O pagamento é feito na {channel === 'DELIVERY' ? 'entrega' : 'retirada'}. Guarde o código para acompanhar o pedido.</p>
      <button type="button" className="mt-5 w-full rounded-xl px-4 py-3 font-semibold text-neutral-950" style={{ background: accent }} onClick={() => { setConfirmation(null); void load(); }}>Fazer novo pedido</button>
    </div>
  </main>;

  const hoursText = store.hours.mode === 'SCHEDULE' ? weeklyText(store.hours.weekly) : [];
  const method = store.paymentMethods.find(entry => entry.id === paymentId);
  const acceptsNow = !closedOnly;
  const minInput = localInput(new Date(loadedAt + 10 * 60_000));
  const maxInput = localInput(new Date(loadedAt + (store.scheduling.maxDaysAhead > 0 ? store.scheduling.maxDaysAhead : 30) * 86_400_000));

  return <main className={`${shell} mx-auto max-w-2xl px-4 pb-28`}>
    <header className="sticky top-0 z-20 -mx-4 border-b border-white/10 bg-neutral-950/95 px-4 py-4 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: accent }}>Cardápio online</p><h1 className="truncate text-xl font-bold text-white">{store.restaurant.name}</h1></div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${store.open ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{store.open ? '● Aberto' : '● Fechado'}</span>
      </div>
      <label className="sr-only" htmlFor="store-search">Buscar no cardápio</label>
      <input id="store-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar no cardápio…" className="mt-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-brand-400" />
      {visible.length > 1 && <nav aria-label="Categorias" className="-mx-1 mt-3 flex gap-2 overflow-x-auto pb-1">{visible.map(category => <a key={category.id ?? 'none'} href={`#cat-${category.id ?? 'none'}`} className="shrink-0 rounded-full border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 hover:border-brand-400 hover:text-brand-300">{category.name}</a>)}</nav>}
    </header>

    {!store.open && <div role="status" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4 text-sm text-amber-200">
      <p className="font-semibold">Estamos fechados no momento.</p>
      <p className="mt-1">{closedOnly ? (canSchedule ? 'Você ainda pode agendar seu pedido para outro dia ou horário.' : 'Não estamos aceitando pedidos agora. Volte mais tarde.') : 'Mesmo fechados, estamos aceitando pedidos.'}</p>
      {hoursText.length > 0 && <p className="mt-2 text-xs text-amber-300/80">Horário: {hoursText.join(' · ')}</p>}
    </div>}
    {store.open && hoursText.length > 0 && <p className="mt-3 text-xs text-neutral-500">Horário: {hoursText.join(' · ')}</p>}
    {store.fulfillment.estimatedTime && <p className="mt-1 text-xs text-neutral-500">Tempo estimado: {store.fulfillment.allowPickup && `retirada ~${store.fulfillment.pickupMinutes} min`}{store.fulfillment.allowPickup && store.fulfillment.allowDelivery && ' · '}{store.fulfillment.allowDelivery && `entrega ~${store.fulfillment.deliveryMinutes} min`}</p>}

    {visible.length === 0 && <p className="mt-8 text-center text-neutral-500">{search ? 'Nenhum produto encontrado.' : 'Nenhum produto disponível no momento.'}</p>}
    {visible.map(category => <section key={category.id ?? 'none'} id={`cat-${category.id ?? 'none'}`} className="mt-6 scroll-mt-40">
      <h2 className="mb-3 flex items-center gap-3 text-lg font-bold tracking-tight text-white"><span className="h-6 w-1 rounded-full" style={{ background: accent }} />{category.name}</h2>
      <div className="grid gap-3">{category.products.map(product => {
        const line = cart[product.id]; const onSale = product.promoPrice !== null && product.promoPrice !== undefined;
        const priceText = formatMoney(onSale ? product.promoPrice : product.price);
        return <article key={product.id} className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-start justify-between gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by the API with its own cache headers */}
            {product.imageVersion && <img src={`/api-proxy/public/store/${encodeURIComponent(slug)}/products/${product.id}/image?v=${product.imageVersion}`} alt={product.name} loading="lazy" className="h-20 w-20 shrink-0 rounded-xl border border-neutral-800 object-cover" />}
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-white">{product.name}</h3>
              {product.description && <p className="mt-1 text-sm text-neutral-400">{product.description}</p>}
              {product.isCombo && product.comboComponents && product.comboComponents.length > 0 && <p className="mt-1 text-xs text-neutral-500">Inclui: {product.comboComponents.map(component => `${component.quantity}× ${component.product.name}`).join(', ')}</p>}
              <p className="mt-2 text-sm font-semibold" style={{ color: accent }}>{onSale && <s className="mr-2 font-normal text-neutral-500">{formatMoney(product.price)}</s>}{priceText}{product.soldByWeight && <span className="font-normal text-neutral-400"> /kg</span>}{onSale && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">Promoção</span>}</p>
            </div>
            {product.soldByWeight
              ? (line ? <button type="button" className="shrink-0 rounded-xl border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:border-red-400 hover:text-red-300" onClick={() => setQuantity(product, 0)}>Remover</button>
                : <button type="button" className="shrink-0 rounded-xl px-4 py-2 text-sm font-semibold text-neutral-950" style={{ background: accent }} onClick={() => setQuantity(product, 1)}>Adicionar</button>)
              : <div className="flex shrink-0 items-center gap-2">
                <button type="button" aria-label={`Remover ${product.name}`} disabled={!line} className="h-10 w-10 rounded-xl border border-neutral-700 text-xl text-neutral-200 transition hover:border-brand-400 disabled:opacity-30" onClick={() => setQuantity(product, (line?.quantity ?? 0) - 1)}>−</button>
                <span aria-live="polite" className="w-6 text-center font-semibold">{line?.quantity ?? 0}</span>
                <button type="button" aria-label={`Adicionar ${product.name}`} disabled={(line?.quantity ?? 0) >= MAX_QTY} className="h-10 w-10 rounded-xl text-xl font-bold text-neutral-950 disabled:opacity-40" style={{ background: accent }} onClick={() => setQuantity(product, (line?.quantity ?? 0) + 1)}>+</button>
              </div>}
          </div>
          {line && product.soldByWeight && <label className="mt-3 block text-sm font-medium text-neutral-300">Peso (kg)<input className={field} inputMode="decimal" autoFocus placeholder="0,350" value={line.weight} onChange={event => patchLine(product.id, { weight: event.target.value })} aria-describedby={`w-${product.id}`} /><span id={`w-${product.id}`} className="mt-1 block text-xs text-neutral-500">Informe o peso desejado em quilos, com até 3 casas decimais (0,001 kg = 1 g).{validWeight(line.weight) ? ` Valor estimado: ${formatMoney(unitPrice(product, line))}` : ''}</span></label>}
          {line && (product.modifierGroups?.length ?? 0) > 0 && <ModifierPicker large groups={product.modifierGroups ?? []} value={line.mods} onChange={mods => patchLine(product.id, { mods })} />}
          {line && <input aria-label={`Observação para ${product.name}`} maxLength={200} placeholder="Observação (ex.: sem cebola)" className="mt-3 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-brand-400" value={line.notes} onChange={event => patchLine(product.id, { notes: event.target.value })} />}
        </article>;
      })}</div>
    </section>)}

    <form id="pedido" onSubmit={submit} className="mt-10 scroll-mt-24 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="text-lg font-bold text-white">Seu pedido</h2>
      {lines.length === 0 ? <p className="mt-2 text-sm text-neutral-500">Nenhum item selecionado.</p> : <ul className="mt-3 grid gap-1 text-sm">{lines.map(product => {
        const line = cart[product.id];
        return <li key={product.id} className="flex justify-between gap-3"><span>{product.soldByWeight ? `${line.weight || '—'} kg` : `${line.quantity}×`} {product.name}{(product.modifierGroups ?? []).flatMap(group => group.options).filter(option => line.mods[option.id]).map(option => <span key={option.id} className="block text-xs text-neutral-500">+ {line.mods[option.id]}× {option.name}</span>)}</span><span className="shrink-0">{formatMoney(unitPrice(product, line) * line.quantity)}</span></li>;
      })}</ul>}

      <fieldset className="mt-5"><legend className="text-sm font-semibold text-neutral-300">Como você quer receber?</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {([['TAKEAWAY', '🛍 Retirada', store.fulfillment.allowPickup], ['DELIVERY', '🛵 Entrega', store.fulfillment.allowDelivery]] as const).map(([value, label, allowed]) => <label key={value} className={`cursor-pointer rounded-xl border px-3 py-3 text-center text-sm font-medium ${!allowed ? 'cursor-not-allowed opacity-40' : channel === value ? 'text-neutral-950' : 'border-neutral-700 text-neutral-300'}`} style={channel === value && allowed ? { background: accent, borderColor: accent } : undefined}>
            <input type="radio" name="fulfillment" className="sr-only" value={value} disabled={!allowed} checked={channel === value} onChange={() => setFulfillment(value)} />{label}
          </label>)}
        </div>
        {!store.fulfillment.allowPickup && !store.fulfillment.allowDelivery && <p className="mt-2 text-xs text-red-300">Esta loja não está recebendo pedidos online no momento.</p>}
      </fieldset>

      {channel === 'DELIVERY' && <div className="mt-4 grid gap-3">
        {store.deliveryZones.length > 0 && <label className="block text-sm font-medium text-neutral-300">Região de entrega<select className={field} value={zoneId} onChange={event => setZoneId(event.target.value)}><option value="">{usesZones ? 'Selecione…' : 'Outra região'}</option>{store.deliveryZones.map(entry => <option key={entry.id} value={entry.id}>{entry.name} — {formatMoney(entry.fee)}{entry.minOrder ? ` (mín. ${formatMoney(entry.minOrder)})` : ''}</option>)}</select></label>}
        <label className="block text-sm font-medium text-neutral-300">Endereço completo<textarea className={field} rows={2} maxLength={300} autoComplete="street-address" placeholder="Rua, número, complemento, bairro" value={address} onChange={event => setAddress(event.target.value)} /></label>
        {store.fulfillment.minDelivery > 0 && <p className="text-xs text-neutral-500">Pedido mínimo para entrega: {formatMoney(store.fulfillment.minDelivery)}.</p>}
        {store.fulfillment.freeDeliveryMin > 0 && <p className="text-xs text-neutral-500">Entrega grátis em pedidos a partir de {formatMoney(store.fulfillment.freeDeliveryMin)}.</p>}
      </div>}

      <fieldset className="mt-5 grid gap-3"><legend className="text-sm font-semibold text-neutral-300">Seus dados</legend>
        <label className="block text-sm font-medium text-neutral-300">Nome<input className={field} maxLength={160} autoComplete="name" required value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="block text-sm font-medium text-neutral-300">Telefone / WhatsApp<input className={field} type="tel" maxLength={30} autoComplete="tel" placeholder="(11) 99999-9999" required value={phone} onChange={event => setPhone(event.target.value)} /></label>
      </fieldset>

      {canSchedule && <fieldset className="mt-5"><legend className="text-sm font-semibold text-neutral-300">Agendar pedido</legend>
        <label className="mt-2 flex items-center gap-3 text-sm text-neutral-300"><input type="checkbox" className="h-5 w-5 accent-amber-500" checked={scheduling} disabled={closedOnly} onChange={event => setSchedule(event.target.checked)} />{closedOnly ? 'Estamos fechados: o pedido será agendado' : 'Quero agendar para outro dia ou horário'}</label>
        {scheduling && <div className="mt-3">
          <label className="block text-sm font-medium text-neutral-300">Data e horário<input className={field} type="datetime-local" required min={minInput} max={maxInput} value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} /></label>
          <p className="mt-2 text-xs text-neutral-500">Aceitamos agendamentos com até {store.scheduling.maxDaysAhead > 0 ? store.scheduling.maxDaysAhead : 30} dia(s) de antecedência.{store.scheduling.slots.length > 0 && ` Faixas permitidas: ${weeklyText(store.scheduling.slots).join(' · ')}.`}{store.scheduling.blockedFrom && store.scheduling.blockedTo && ` Sem agendamentos de ${store.scheduling.blockedFrom.split('-').reverse().join('/')} a ${store.scheduling.blockedTo.split('-').reverse().join('/')}.`}</p>
        </div>}
      </fieldset>}

      <label className="mt-5 block text-sm font-medium text-neutral-300">Cupom de desconto (opcional)<input className={`${field} uppercase`} maxLength={40} autoComplete="off" value={coupon} onChange={event => setCoupon(event.target.value)} /><span className="mt-1 block text-xs font-normal text-neutral-500">O desconto é validado e aplicado ao enviar o pedido.</span></label>

      {store.paymentMethods.length > 0 && <label className="mt-5 block text-sm font-medium text-neutral-300">Forma de pagamento<select className={field} value={paymentId} onChange={event => setPaymentId(event.target.value)}><option value="">Combinar na {channel === 'DELIVERY' ? 'entrega' : 'retirada'}</option>{store.paymentMethods.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}
      {method?.allowChange && method.equivalent === 'CASH' && <label className="mt-3 block text-sm font-medium text-neutral-300">Troco para (opcional)<input className={field} inputMode="decimal" placeholder="Ex.: 100,00" value={changeFor} onChange={event => setChangeFor(event.target.value)} /></label>}
      <label className="mt-5 block text-sm font-medium text-neutral-300">Observações do pedido (opcional)<textarea className={field} rows={2} maxLength={300} value={notes} onChange={event => setNotes(event.target.value)} /></label>

      <div className="mt-5 grid gap-1 border-t border-neutral-800 pt-4 text-sm">
        <div className="flex justify-between"><span className="text-neutral-400">Subtotal</span><span>{formatMoney(subtotal)}</span></div>
        {channel === 'DELIVERY' && <div className="flex justify-between"><span className="text-neutral-400">Entrega</span><span>{usesZones && !zone ? 'Escolha a região' : deliveryFee === 0 ? 'Grátis' : formatMoney(deliveryFee)}</span></div>}
        <div className="flex justify-between text-base font-bold"><span>Total estimado</span><span style={{ color: accent }}>{formatMoney(total)}</span></div>
      </div>
      {formError && <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{formError}</div>}
      <button disabled={busy || lines.length === 0 || !channel || (closedOnly && !canSchedule)} className="mt-5 w-full rounded-xl px-4 py-4 text-base font-semibold text-neutral-950 transition disabled:cursor-not-allowed disabled:opacity-50" style={{ background: accent }}>{busy ? 'Enviando...' : scheduling ? `Agendar pedido · ${formatMoney(total)}` : `Enviar pedido · ${formatMoney(total)}`}</button>
      <p className="mt-3 text-center text-xs text-neutral-500">{acceptsNow ? 'O pagamento é feito na ' : 'O pagamento será feito na '}{channel === 'DELIVERY' ? 'entrega' : 'retirada'}; o valor final confirma o desconto do cupom.</p>
    </form>

    {lines.length > 0 && <a href="#pedido" className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-2xl items-center justify-between rounded-2xl px-5 py-3.5 font-semibold text-neutral-950 shadow-2xl" style={{ background: accent }}><span>Ver pedido ({lines.length})</span><span>{formatMoney(total)}</span></a>}
  </main>;
}
