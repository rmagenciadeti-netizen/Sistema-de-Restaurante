'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, formatMoney, ListResponse, ModifierGroup, ModifierGroupView, ProductComposition, storedUser, toIso, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import type { SettingsResponse, TenantSettings } from '../../lib/settings';
import { foreignTotals } from '../../lib/settings-helpers';
import { parseQuantity } from '../../lib/quantity';
import { AppShell, buttonClass, Check, Field, inputClass, Notice, secondaryButtonClass, Select } from '../../components/app-shell';
import { ModifierPicker, ModifierSelection, modifiersPayload, selectionError } from '../../components/modifier-picker';
import { OpsNav } from '../../components/ops-nav';
import { ProductPhoto } from '../../components/product-photo';
import { OrderReceipt, PickupTicket, pickupTicketItems } from '../../components/order-receipt';
import { OnlineCharges } from '../../components/online-charges';
import { PasswordReleaseDialog } from '../../components/password-release';
import type { ReleaseAction } from '../../lib/types-settings';
import { textareaClass } from '../../components/ui';
import { FiscalChoiceDialog, fiscalCheckout, FiscalReadinessBanner, InutilizationDialog } from '../../components/pdv-fiscal';
import type { FiscalSettingsView } from '../../lib/types-fiscal';
import {
  DEFAULT_PAYMENT_METHODS, opsError, orderTitle, promoPrice, toLocalInput,
  type CoverEventNow, type OpsCashSession, type OpsCustomer, type OpsOrder, type OpsProduct, type OpsPromotion, type OpsTable, type OpsZone, type PaymentMethodOption, type ScaleLookup,
} from '../../lib/types-ops';

type CartLine = { key: string; product: OpsProduct; quantity: number | string; weightKg: number | null; unitPrice: number | null; withPackaging: boolean; notes: string; modifiers: { optionId: string; name: string; price: number; quantity: number }[] };
type ChannelKey = 'POS' | 'TAKEAWAY' | 'DELIVERY' | 'TABLE' | 'TAB';
type Config = { product: OpsProduct; groups: ModifierGroupView[]; weight: string; unitPrice: string; sel: ModifierSelection; withPackaging: boolean; notes: string; error: string };

const DEFAULT_PDV: TenantSettings['pdv'] = { layout: 'FOOD', side: 'RIGHT', orderMode: true, saleMode: true, whatsappNotify: true, autoRegisterCustomer: true, tableControl: 'TABLES_AND_TABS', askSeller: false, serviceFeeName: 'Taxa de serviço', defaultOrderStatus: 'OPEN', requireAdminPasswordOnline: false, showPixOnTerminal: false, usdRate: 0, pesoRate: 0 };
const channelOptions: { key: ChannelKey; label: string }[] = [{ key: 'POS', label: 'Balcão' }, { key: 'TAKEAWAY', label: 'Retirada' }, { key: 'DELIVERY', label: 'Entrega' }, { key: 'TABLE', label: 'Mesa' }, { key: 'TAB', label: 'Comanda' }];
const round2 = (value: number) => Math.round(value * 100) / 100;
const normalize = (value: string) => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Optional modules may be missing (404/501) or forbidden for the user's role (403); the PDV keeps working without them.
const optional = <T,>(request: Promise<T>, fallback: T) => request.catch(error => { if (error instanceof ApiError && [403, 404, 501].includes(error.status)) return fallback; throw error; });

async function loadProducts() {
  const items: OpsProduct[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await api<ListResponse<OpsProduct>>(`/products?pageSize=100&page=${page}`);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items.filter(product => product.active);
}

export default function PdvPage() {
  const shell = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const urlHandled = useRef(false);
  const customerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSubmit = useRef<'order' | 'sale'>('order');
  const pendingRelease = useRef<'DISCOUNT' | 'ONLINE_ORDER'>('DISCOUNT');
  const fiscalResolver = useRef<((emit: boolean) => void) | null>(null);

  const [products, setProducts] = useState<OpsProduct[]>([]);
  const [promotions, setPromotions] = useState<OpsPromotion[]>([]);
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [tables, setTables] = useState<OpsTable[]>([]);
  const [zones, setZones] = useState<OpsZone[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [groupsCatalog, setGroupsCatalog] = useState<ModifierGroup[]>([]);
  const [compositions, setCompositions] = useState<Record<string, ProductComposition>>({});
  const [sessions, setSessions] = useState<OpsCashSession[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethodOption[]>(DEFAULT_PAYMENT_METHODS);
  const [cover, setCover] = useState<CoverEventNow | null>(null);
  const [minSchedule, setMinSchedule] = useState('');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [channel, setChannel] = useState<ChannelKey>('POS');
  const [unitId, setUnitId] = useState('');
  const [tableId, setTableId] = useState('');
  const [tabLabel, setTabLabel] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [customer, setCustomer] = useState<OpsCustomer | null>(null);
  const [customerTerm, setCustomerTerm] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerResults, setCustomerResults] = useState<OpsCustomer[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [observation, setObservation] = useState('');
  const [adjMode, setAdjMode] = useState<'DISCOUNT' | 'SURCHARGE'>('DISCOUNT');
  const [adjType, setAdjType] = useState<'FIXED' | 'PERCENT'>('FIXED');
  const [adjValue, setAdjValue] = useState('');
  const [sellers, setSellers] = useState<{ id: string; name: string }[]>([]); const [sellerId, setSellerId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [orderReleaseId, setOrderReleaseId] = useState('');
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseAction, setReleaseAction] = useState<ReleaseAction>('DISCOUNT');
  const [applyFee, setApplyFee] = useState(true);
  const [people, setPeople] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [onlinePixOrderId, setOnlinePixOrderId] = useState('');
  const [methodId, setMethodId] = useState('');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');
  const [lastOrder, setLastOrder] = useState<OpsOrder | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [printNonce, setPrintNonce] = useState(0);
  const [printContent, setPrintContent] = useState({ receipt: true, ticket: false });
  const [fiscalSettings, setFiscalSettings] = useState<FiscalSettingsView | null>(null);
  const [fiscalAsk, setFiscalAsk] = useState(false);
  const [inutilOpen, setInutilOpen] = useState(false);

  const pdv = settings?.pdv ?? DEFAULT_PDV;
  const unit = units.find(item => item.id === unitId);
  const table = tables.find(item => item.id === tableId);
  const zone = zones.find(item => item.id === zoneId);
  const isTable = channel === 'TABLE' || channel === 'TAB';
  const canSchedule = Boolean(settings?.scheduling.enabled) && !isTable;

  async function load() {
    try {
      const [catalog, settingsResult, promotionList, tableList, zoneList, groupList, unitList, sessionList, methodList, coverNow, fiscalView] = await Promise.all([
        loadProducts(),
        optional(api<SettingsResponse>('/settings'), null),
        optional(api<ListResponse<OpsPromotion>>('/promotions'), { items: [], total: 0 }),
        optional(api<ListResponse<OpsTable>>('/tables'), { items: [], total: 0 }),
        optional(api<ListResponse<OpsZone>>('/delivery/zones'), { items: [], total: 0 }),
        optional(api<ListResponse<ModifierGroup>>('/catalog/modifier-groups'), { items: [], total: 0 }),
        api<ListResponse<Unit>>('/units'),
        optional(api<ListResponse<OpsCashSession>>('/cash/sessions'), null),
        optional(api<{ items: PaymentMethodOption[] }>('/payment-methods/options'), { items: [] }),
        optional(api<unknown>('/cover-events/current'), null),
        optional(api<FiscalSettingsView>('/fiscal/settings'), null).catch(() => null),
      ]);
      setProducts(catalog); setSettings(settingsResult?.settings ?? null); setFiscalSettings(fiscalView); setPromotions(promotionList.items);
      if (settingsResult?.settings.pdv.askSeller) {
        const staff = await optional(api<ListResponse<{ id: string; name: string }>>('/orders/sellers'), { items: [], total: 0 });
        setSellers(staff.items);
        // The last seller used on this terminal is preselected, so the attendant only changes it when someone else takes over.
        const remembered = localStorage.getItem('rm_pdv_seller') ?? ''; setSellerId(current => current || (staff.items.some(item => item.id === remembered) ? remembered : ''));
      }
      const activeTables = tableList.items.filter(item => item.active); setTables(activeTables); setZones(zoneList.items.filter(item => item.active));
      setGroupsCatalog(groupList.items);
      const activeUnits = unitList.items.filter(item => item.status === 'ACTIVE'); setUnits(activeUnits);
      setSessions(sessionList ? sessionList.items.filter(item => item.status === 'OPEN') : null);
      setMethods(methodList.items.length ? methodList.items : DEFAULT_PAYMENT_METHODS);
      const event = (coverNow as { event?: CoverEventNow } | null)?.event ?? (coverNow as CoverEventNow | null);
      setCover(event && typeof event === 'object' && 'amount' in event ? event : null);
      setMinSchedule(toLocalInput(new Date(Date.now() + 10 * 60000)));
      const ownUnit = storedUser().unitId ?? '';
      setUnitId(current => current || ownUnit || (activeUnits.length === 1 ? activeUnits[0].id : ''));
      if (!urlHandled.current) {
        urlHandled.current = true;
        const params = new URLSearchParams(window.location.search);
        const wantedTable = params.get('tableId'); const wantedTab = params.get('tab');
        if (wantedTable) {
          const found = activeTables.find(item => item.id === wantedTable);
          if (found) { setChannel('TABLE'); setTableId(found.id); setUnitId(found.unitId); } else setMessage('Mesa indisponível ou sem acesso. Selecione outra mesa.');
        } else if (wantedTab) { setChannel('TAB'); setTabLabel(wantedTab.slice(0, 30)); }
      }
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar o PDV')); }
  }
  useAutoLoad(load);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  useEffect(() => {
    if (printNonce === 0) return;
    const id = setTimeout(() => window.print(), 80);
    return () => clearTimeout(id);
  }, [printNonce]);

  // ---------- catalog ----------
  const categories = Array.from(new Map(products.filter(product => product.category).map(product => [product.category!.id, product.category!.name] as [string, string])).entries());
  const hasFavorites = products.some(product => product.favorite);
  const term = normalize(search.trim());
  const shown = products.filter(product => {
    if (category === 'FAV' ? !product.favorite : category !== 'ALL' && product.category?.id !== category) return false;
    return !term || normalize(`${product.name} ${product.code ?? ''}`).includes(term) || (product.barcode ?? '').includes(term);
  });
  const unitPrice = (product: OpsProduct) => promoPrice(product, promotions);

  async function groupsFor(product: OpsProduct): Promise<ModifierGroupView[]> {
    let composition = compositions[product.id];
    if (!composition) {
      try { composition = await api<ProductComposition>(`/catalog/products/${product.id}/composition`); setCompositions(current => ({ ...current, [product.id]: composition })); }
      catch (error) { if (!(error instanceof ApiError && [403, 404].includes(error.status))) throw error; return []; }
    }
    return groupsCatalog.filter(group => group.active && composition.modifierGroups.some(link => link.groupId === group.id)).map(group => ({ ...group, options: group.options.filter(option => option.active !== false) })).filter(group => group.options.length > 0);
  }

  function pushLine(product: OpsProduct, quantity: number, weightKg: number | null, notes: string, sel: ModifierSelection, groups: ModifierGroupView[], customUnitPrice: number | null = null, withPackaging = false) {
    const modifiers = modifiersPayload(sel).map(entry => { const option = groups.flatMap(group => group.options).find(candidate => candidate.id === entry.optionId)!; return { optionId: entry.optionId, name: option.name, price: Number(option.price), quantity: entry.quantity }; });
    const key = `${product.id}|${weightKg ?? ''}|${customUnitPrice ?? ''}|${withPackaging}|${notes}|${modifiers.map(modifier => `${modifier.optionId}x${modifier.quantity}`).sort().join(',')}`;
    setCart(current => {
      const existing = current.find(line => line.key === key);
      if (existing && weightKg === null) return current.map(line => line.key === key ? { ...line, quantity: Math.min(999, (parseQuantity(line.quantity, Boolean(line.product.allowFractionalQuantity), 999) ?? 0) + quantity) } : line);
      return [...current, { key: existing ? `${key}#${Date.now()}` : key, product, quantity, weightKg, unitPrice: customUnitPrice, withPackaging, notes, modifiers }];
    });
  }

  async function addProduct(product: OpsProduct, weightKg?: number) {
    setMessage(''); setSuccess('');
    try {
      const groups = product.isCombo ? [] : await groupsFor(product);
      if ((product.soldByWeight && !weightKg) || (product.allowFreePrice && !product.soldByWeight) || groups.length > 0 || product.packagingEnabled) { setConfig({ product, groups, weight: weightKg ? String(weightKg) : '', unitPrice: unitPrice(product).toFixed(2), sel: {}, withPackaging: false, notes: '', error: '' }); return; }
      pushLine(product, 1, weightKg ?? null, '', {}, []);
    } catch (error) { setMessage(errorMessage(error, 'Erro ao carregar o produto')); }
  }

  function confirmConfig() {
    if (!config) return;
    const weight = config.weight ? Number(config.weight.replace(',', '.')) : null;
    if (config.product.soldByWeight && (!weight || !(weight > 0) || weight > 999.999)) { setConfig({ ...config, error: 'Informe o peso em kg (até 999,999).' }); return; }
    const priceText = config.unitPrice.trim().replace(',', '.');
    const customUnitPrice = config.product.allowFreePrice && !config.product.soldByWeight ? Number(priceText) : null;
    if (customUnitPrice !== null && (!/^\d{1,10}(?:\.\d{1,2})?$/.test(priceText) || !Number.isFinite(customUnitPrice) || customUnitPrice > 9_999_999_999.99)) { setConfig({ ...config, error: 'Informe um preço válido, não negativo, com até duas casas decimais.' }); return; }
    const invalid = selectionError(config.groups, config.sel);
    if (invalid) { setConfig({ ...config, error: invalid }); return; }
    pushLine(config.product, 1, weight ? round2(weight * 1000) / 1000 : null, config.notes.trim(), config.sel, config.groups, customUnitPrice, config.withPackaging);
    setConfig(null);
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const text = search.trim();
    if (!text) return;
    setMessage('');
    try {
      if (settings?.scale.enabled && /^\d{12,14}$/.test(text) && text.startsWith(settings.scale.prefix)) {
        try {
          const found = await api<ScaleLookup>(`/scale/lookup?barcode=${encodeURIComponent(text)}`);
          const product = products.find(item => item.id === found.product.id);
          if (product) {
            const weight = found.weightKg ? Number(found.weightKg) : found.total && Number(product.price) > 0 ? Math.round(Number(found.total) / unitPrice(product) * 1000) / 1000 : 0;
            if (weight > 0) { setSearch(''); await addProduct(product, weight); return; }
          }
        } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      }
      const exact = products.find(product => product.barcode === text || product.code === text);
      if (exact) { setSearch(''); await addProduct(exact); return; }
      if (shown.length === 1) { setSearch(''); await addProduct(shown[0]); return; }
      setMessage(shown.length === 0 ? 'Produto não encontrado.' : 'Vários produtos encontrados: escolha na grade.');
    } catch (error) { setMessage(opsError(error, 'Erro ao ler o código')); }
  }

  // ---------- customer ----------
  function typeCustomer(value: string) {
    setCustomerTerm(value); setCustomer(null);
    if (customerTimer.current) clearTimeout(customerTimer.current);
    if (value.trim().length < 2) { setCustomerResults([]); return; }
    customerTimer.current = setTimeout(() => {
      api<ListResponse<OpsCustomer>>(`/customers?pageSize=6&search=${encodeURIComponent(value.trim())}`).then(result => setCustomerResults(result.items)).catch(() => setCustomerResults([]));
    }, 300);
  }

  // ---------- totals (estimate; the server recalculates everything) ----------
  const lineTotal = (line: CartLine) => {
    const base = line.unitPrice ?? unitPrice(line.product);
    const each = (line.weightKg ? round2(base * line.weightKg) : base) + line.modifiers.reduce((sum, modifier) => sum + modifier.price * modifier.quantity, 0) + (line.withPackaging ? Number(line.product.packagingPrice ?? 0) : 0);
    return round2(each * (parseQuantity(line.quantity, Boolean(line.product.allowFractionalQuantity && !line.product.soldByWeight), 999) ?? 0));
  };
  const subtotal = round2(cart.reduce((sum, line) => sum + lineTotal(line), 0));
  const adjInput = Number(adjValue.replace(',', '.')) || 0;
  const adjAmount = adjInput > 0 ? round2(adjType === 'PERCENT' ? subtotal * adjInput / 100 : adjInput) : 0;
  const discountAmount = adjMode === 'DISCOUNT' ? Math.min(adjAmount, subtotal) : 0;
  const surchargeAmount = adjMode === 'SURCHARGE' ? adjAmount : 0;
  const feePercent = Number(unit?.serviceFeePercent ?? 0);
  const serviceFee = isTable && applyFee ? round2((subtotal - discountAmount) * feePercent / 100) : 0;
  const peopleCount = Math.floor(Number(people)) || 0;
  const couvert = isTable && cover && peopleCount > 0 ? round2(Number(cover.amount) * peopleCount) : 0;
  const deliveryFee = channel === 'DELIVERY' && zone ? Number(zone.fee) : 0;
  const total = round2(subtotal - discountAmount + surchargeAmount + serviceFee + couvert + deliveryFee);

  const method = methods.find(item => item.id === methodId) ?? methods[0];
  const receivedValue = Number(received.replace(',', '.')) || 0;
  const orderUnit = isTable && table ? table.unitId : unitId;
  const openSession = sessions?.find(item => (item.unitId ?? '') === orderUnit);

  function validate(): string | null {
    if (cart.length === 0) return 'Adicione ao menos um produto ao carrinho.';
    if (cart.some(line => parseQuantity(line.quantity, Boolean(line.product.allowFractionalQuantity && !line.product.soldByWeight), 999) === null)) return 'Confira as quantidades dos produtos (até três casas decimais para itens fracionados).';
    if (pdv.askSeller && !sellerId) return 'Selecione o vendedor responsável pela venda.';
    if (channel === 'TABLE' && !tableId) return 'Selecione a mesa.';
    if (channel === 'TAB' && !tabLabel.trim()) return 'Informe o número ou nome da comanda.';
    if (channel === 'DELIVERY' && !zoneId && zones.length > 0) return 'Selecione a zona de entrega.';
    if (scheduleOn && !scheduledFor) return 'Informe a data e a hora do agendamento.';
    if (adjInput > 0 && adjMode === 'DISCOUNT' && adjAmount > subtotal) return 'O desconto não pode ser maior que o sub-total.';
    return null;
  }

  async function createOrder(release: string, orderRelease: string): Promise<OpsOrder> {
    const lines = cart.map((line, index) => {
      const noteParts = [index === 0 && observation.trim() ? `[Pedido] ${observation.trim()}` : '', line.notes].filter(Boolean).join(' · ').slice(0, 500);
      return { productId: line.product.id, quantity: parseQuantity(line.quantity, Boolean(line.product.allowFractionalQuantity && !line.product.soldByWeight), 999), weightKg: line.weightKg ?? undefined, unitPrice: line.unitPrice ?? undefined, withPackaging: line.withPackaging || undefined, notes: noteParts || undefined, modifiers: line.modifiers.length ? line.modifiers.map(modifier => ({ optionId: modifier.optionId, quantity: modifier.quantity })) : undefined };
    });
    const chosenName = customer?.name ?? customerName.trim();
    const knownCustomer = Boolean(customer);
    const phoneAllowed = Boolean(chosenName) && (knownCustomer || pdv.autoRegisterCustomer);
    const phoneText = customer?.phone ?? customerTerm.replace(/[^\d+]/g, '');
    return api<OpsOrder>('/orders', { method: 'POST', body: JSON.stringify({
      channel: channel === 'TAB' ? 'TABLE' : channel,
      unitId: orderUnit || undefined,
      tableId: channel === 'TABLE' ? tableId : undefined,
      tableLabel: channel === 'TAB' ? tabLabel.trim() : undefined,
      deliveryZoneId: channel === 'DELIVERY' && zoneId ? zoneId : undefined,
      customerName: chosenName || undefined,
      customerPhone: phoneAllowed && phoneText.replace(/\D/g, '').length >= 8 ? phoneText : undefined,
      couponCode: couponCode.trim() || undefined,
      applyServiceFee: isTable ? applyFee : undefined,
      couvertPeople: isTable && cover && peopleCount > 0 ? peopleCount : undefined,
      scheduledFor: scheduleOn && canSchedule && scheduledFor ? toIso(scheduledFor) : undefined,
      adjustment: adjAmount > 0 ? { mode: adjMode, type: adjType, value: adjInput } : undefined,
      adjustmentReleaseId: release || undefined,
      orderReleaseId: orderRelease || undefined,
      sellerId: pdv.askSeller && sellerId ? sellerId : undefined,
      items: lines,
    }) });
  }

  function resetCart() {
    setCart([]); setCouponCode(''); setObservation(''); setAdjValue(''); setReleaseId(''); setOrderReleaseId(''); setPeople(''); setScheduleOn(false); setScheduledFor(''); setReceived('');
    setCustomer(null); setCustomerTerm(''); setCustomerName(''); setCustomerResults([]);
    if (channel === 'POS' || channel === 'TAKEAWAY' || channel === 'DELIVERY') setZoneId('');
  }

  function askToPrint(order: OpsOrder, sale: boolean) {
    const askReceipt = sale ? settings?.printing.askPrintSale : settings?.printing.askPrintOrder;
    const receipt = Boolean(askReceipt && window.confirm('Imprimir o comprovante agora?'));
    const ticket = Boolean(settings?.ticket.enabled && settings.printing.askPrintTicket && pickupTicketItems(order).length && window.confirm('Imprimir o ticket de retirada agora?'));
    if (receipt || ticket) { setPrintContent({ receipt, ticket }); setLastOrder(order); setPrintNonce(value => value + 1); }
  }

  function askFiscal() {
    return new Promise<boolean>(resolve => { fiscalResolver.current = resolve; setFiscalAsk(true); });
  }

  async function submit(mode: 'order' | 'sale', authorizedRelease?: string, authorizedOrderRelease?: string) {
    const problem = validate();
    if (problem) { setMessage(problem); return; }
    const release = authorizedRelease ?? releaseId;
    const orderRelease = authorizedOrderRelease ?? orderReleaseId;
    const role = storedUser().role;
    const needsOnlineRelease = pdv.requireAdminPasswordOnline && isTable && role !== 'ADMIN' && role !== 'MANAGER';
    if (needsOnlineRelease && !orderRelease) {
      pendingSubmit.current = mode; pendingRelease.current = 'ONLINE_ORDER'; setReleaseAction('OTHER'); setReleaseOpen(true); return;
    }
    const needsRelease = adjMode === 'DISCOUNT' && adjAmount > 0 && role !== 'ADMIN' && role !== 'MANAGER' && !release;
    if (needsRelease) { pendingSubmit.current = mode; pendingRelease.current = 'DISCOUNT'; setReleaseAction('DISCOUNT'); setReleaseOpen(true); return; }
    if (mode === 'sale' && !payOpen) { setPayOpen(true); return; }
    setBusy(true); setMessage(''); setSuccess('');
    let order: OpsOrder | null = null;
    try {
      order = await createOrder(release, orderRelease);
      setLastOrder(order);
      if (mode === 'order') {
        setSuccess(`Pedido ${orderTitle(order)} gerado e enviado à produção${order.scheduledFor && !order.releasedAt ? ' (agendado: ficará retido até o horário)' : ''}. O pagamento pode ser feito depois no caixa.`);
        askToPrint(order, false); resetCart(); return;
      }
      if (pdv.showPixOnTerminal && method.equivalent === 'PIX') {
        setLastOrder(order); setOnlinePixOrderId(order.id); setPayOpen(false);
        setSuccess(`Pedido ${orderTitle(order)} gerado. Gere a cobrança PIX e aguarde a confirmação do provedor.`);
        resetCart(); return;
      }
      if (!openSession) throw new Error('Nenhum caixa aberto para esta unidade.');
      const paid = await api<{ payment: { id: string; amount: string | number; method: string } }>('/cash/payments', { method: 'POST', body: JSON.stringify({ orderId: order.id, method: method.equivalent, amount: Number(order.total).toFixed(2), cashSessionId: openSession.id, reference: DEFAULT_PAYMENT_METHODS.some(item => item.id === method.id) ? undefined : method.name }) });
      const settled = { ...order, payments: [{ id: paid.payment.id, amount: paid.payment.amount, method: paid.payment.method }] };
      setLastOrder(settled);
      const change = method.allowChange && receivedValue > Number(order.total) ? ` Troco: ${formatMoney(receivedValue - Number(order.total))}.` : '';
      setPayOpen(false);
      // Fiscal emission never undoes the sale: its outcome is only appended to the success message.
      const fiscalMode = fiscalSettings?.pdvMode;
      const fiscalNote = fiscalMode === 'FISCAL' ? await fiscalCheckout(order.id) : fiscalMode === 'ASK' ? await fiscalCheckout(order.id, await askFiscal()) : '';
      setSuccess(`Venda ${orderTitle(order)} registrada: ${formatMoney(order.total)} em ${method.name}.${change}${fiscalNote ? ` ${fiscalNote}` : ''}`);
      askToPrint(settled, true); resetCart();
    } catch (error) {
      if (order) { setMessage(`Pedido ${orderTitle(order)} foi gerado, mas o pagamento não foi registrado: ${opsError(error, 'erro ao pagar')}. Conclua em Caixa.`); setPayOpen(false); resetCart(); }
      else setMessage(opsError(error, 'Erro ao gerar o pedido'));
    } finally { setBusy(false); }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.().catch(() => setMessage('Seu navegador não permitiu tela cheia.'));
  }
  function printLast() {
    if (!lastOrder) { setMessage('Ainda não há pedido gerado nesta sessão para imprimir.'); return; }
    setPrintContent({ receipt: true, ticket: false });
    setPrintNonce(value => value + 1);
  }

  function printPickupTicket() {
    if (!lastOrder || !settings?.ticket.enabled || pickupTicketItems(lastOrder).length === 0) return;
    setPrintContent({ receipt: false, ticket: true });
    setPrintNonce(value => value + 1);
  }

  const summarySide = pdv.side === 'LEFT' ? 'lg:order-first' : '';
  const tableOptions = tables.filter(item => !unitId || item.unitId === unitId);
  const channelsAllowed = channelOptions.filter(option => option.key === 'TABLE' ? pdv.tableControl !== 'TABS' : option.key === 'TAB' ? pdv.tableControl !== 'TABLES' : true);
  const actionButton = 'grid h-11 w-11 place-items-center rounded-xl border border-white/15 text-lg text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400';

  return <AppShell title="PDV">
    <div className="print:hidden">
      <OpsNav />
      <div ref={shell} className={fullscreen ? 'h-screen overflow-auto bg-[var(--canvas)] p-3' : ''}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-neutral-950 px-3 py-2 text-white shadow-md">
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-300">Ponto de venda</p><p className="truncate text-sm text-neutral-300">{isTable ? (channel === 'TABLE' ? `Mesa ${table?.label ?? '—'}` : `Comanda ${tabLabel || '—'}`) : channelOptions.find(option => option.key === channel)?.label}{unit ? ` · ${unit.name}` : ''}</p></div>
          <div className="flex items-center gap-2" role="toolbar" aria-label="Ações do PDV">
            <Link href="/cash" title="Caixa e pagamentos" aria-label="Caixa e pagamentos" className={actionButton}>💳</Link>
            <button type="button" title="Imprimir último pedido" aria-label="Imprimir último pedido" onClick={printLast} className={actionButton}>🖨️</button>
            <button type="button" title="Inutilizar numeração" aria-label="Inutilizar numeração" onClick={() => setInutilOpen(true)} className={actionButton}>🚫</button>
            <button type="button" title="Recarregar produtos e configurações" aria-label="Recarregar" onClick={() => void load()} className={actionButton}>↻</button>
            <button type="button" title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} aria-pressed={fullscreen} onClick={toggleFullscreen} className={actionButton}>⛶</button>
          </div>
        </div>
        {message && <Notice message={message} />}
        {success && <Notice message={success} kind="success" />}
        <FiscalReadinessBanner settings={fiscalSettings} />
        {sessions !== null && sessions.length === 0 && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Nenhum caixa aberto: você pode gerar pedidos, mas a venda com pagamento exige caixa aberto.<Link href="/cash" className="font-semibold underline">Abrir caixa</Link></div>}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
          <section aria-label="Produtos" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <form onSubmit={event => void submitSearch(event)} className="flex gap-2">
              <input ref={searchRef} type="search" aria-label="Buscar produto ou ler código de barras" placeholder="Buscar produto, código ou ler código de barras (Enter)" value={search} onChange={event => setSearch(event.target.value)} className={`${inputClass} !mt-0 min-h-12 flex-1 text-base`} />
              <button className={`${buttonClass} min-h-12 px-5`}>Adicionar</button>
            </form>
            <div role="group" aria-label="Categorias" className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {[{ id: 'ALL', name: 'Todos' }, ...(hasFavorites ? [{ id: 'FAV', name: '★ Favoritos' }] : []), ...categories.map(([id, name]) => ({ id, name }))].map(chip => <button key={chip.id} type="button" aria-pressed={category === chip.id} onClick={() => setCategory(chip.id)} className={`min-h-11 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${category === chip.id ? 'bg-neutral-950 text-brand-300' : 'border border-slate-300 bg-white text-slate-700 hover:border-brand-400'}`}>{chip.name}</button>)}
            </div>
            <div className="mt-3 grid max-h-[62vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {shown.map(product => {
                const price = unitPrice(product); const promo = price < Number(product.price);
                return <button key={product.id} type="button" onClick={() => void addProduct(product)} className="relative flex min-h-28 flex-col justify-between overflow-hidden rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-brand-500 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 active:scale-[0.98]">
                  {product.allowFreePrice && !product.soldByWeight && <span className="absolute right-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-900">Preço livre</span>}
                  {promo && <span className="absolute right-2 top-8 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">Promo</span>}
                  <ProductPhoto productId={product.id} version={product.image?.updatedAt} name={product.name} />
                  <span className="pr-10 text-sm font-semibold leading-tight text-slate-900">{product.name}</span>
                  {product.alwaysShowDescription && product.description && <span className="mt-1 line-clamp-2 text-xs leading-snug text-slate-500">{product.description}</span>}
                  <span className="mt-2 block text-xs text-slate-500">{product.code || product.category?.name || ''}</span>
                  <span className="mt-1 flex items-baseline gap-1.5">{promo && <s className="text-xs text-slate-400">{formatMoney(product.price)}</s>}<strong className="text-base text-brand-700">{formatMoney(price)}</strong>{product.soldByWeight && <span className="text-xs font-semibold text-slate-500">/kg</span>}</span>
                </button>;
              })}
              {shown.length === 0 && <p className="col-span-full py-6 text-center text-sm text-slate-500">{products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto ativo cadastrado.'}</p>}
            </div>
          </section>

          <aside aria-label="Resumo do pedido" className={`${summarySide} space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto`}>
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-slate-900">Resumo</h2>{cart.length > 0 && <button type="button" className="text-xs font-semibold text-red-700 hover:underline" onClick={() => { if (window.confirm('Limpar todos os itens do carrinho?')) setCart([]); }}>Limpar</button>}</div>

            <div role="group" aria-label="Canal de venda" className="flex flex-wrap gap-1">
              {channelsAllowed.map(option => <button key={option.key} type="button" aria-pressed={channel === option.key} onClick={() => {
                if (option.key !== 'POS' && cart.some(line => line.unitPrice !== null)) { setMessage('Remova os preços livres do carrinho antes de trocar o canal; preço livre só pode ser usado no Balcão.'); return; }
                setChannel(option.key);
              }} className={`min-h-11 flex-1 rounded-lg px-2 text-sm font-semibold transition ${channel === option.key ? 'bg-brand-500 text-neutral-950' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'}`}>{option.label}</button>)}
            </div>
            {units.length > 1 && !storedUser().unitId && <Select label="Unidade" value={unitId} onChange={event => { setUnitId(event.target.value); setTableId(''); }}><option value="">Selecione</option>{units.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
            {channel === 'DELIVERY' && <Select label="Zona de entrega" value={zoneId} onChange={event => setZoneId(event.target.value)}><option value="">Selecione</option>{zones.map(item => <option key={item.id} value={item.id}>{item.name} — {formatMoney(item.fee)}</option>)}</Select>}
            {channel === 'TABLE' && <Select label="Mesa" value={tableId} onChange={event => setTableId(event.target.value)}><option value="">Selecione</option>{tableOptions.map(item => <option key={item.id} value={item.id}>Mesa {item.label} ({item.seats} lugares)</option>)}</Select>}
            {channel === 'TAB' && <Field label="Comanda (número ou nome)" maxLength={30} value={tabLabel} onChange={event => setTabLabel(event.target.value)} />}

            <ul className="divide-y divide-slate-100" aria-label="Itens do carrinho">
              {cart.map(line => <li key={line.key} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{line.product.name}{line.weightKg ? <span className="font-normal text-slate-500"> · {line.weightKg.toFixed(3).replace('.', ',')} kg</span> : null}</p>
                    {line.modifiers.length > 0 && <p className="text-xs text-slate-500">{line.modifiers.map(modifier => `+ ${modifier.quantity}× ${modifier.name}`).join(', ')}</p>}
                    {line.withPackaging && <p className="text-xs text-slate-500">+ Embalagem</p>}
                    {line.notes && <p className="text-xs text-amber-700">Obs.: {line.notes}</p>}</div>
                  <span className="whitespace-nowrap text-sm font-bold">{formatMoney(lineTotal(line))}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {line.weightKg === null && line.product.allowFractionalQuantity
                    ? <label className="flex items-center gap-1 text-xs text-slate-600">Quantidade<input aria-label={`Quantidade de ${line.product.name}`} type="text" inputMode="decimal" value={line.quantity} onChange={event => setCart(current => current.map(item => item.key === line.key ? { ...item, quantity: event.target.value } : item))} className="h-10 w-24 rounded-lg border border-slate-300 px-2 text-sm" /></label>
                    : line.weightKg === null
                    ? <span className="flex items-center gap-1"><button type="button" aria-label={`Diminuir ${line.product.name}`} onClick={() => setCart(current => current.flatMap(item => item.key === line.key ? (Number(item.quantity) > 1 ? [{ ...item, quantity: Number(item.quantity) - 1 }] : []) : [item]))} className="h-10 w-10 rounded-lg border border-slate-300 text-lg font-bold hover:bg-slate-50">−</button><span className="w-8 text-center font-semibold">{line.quantity}</span><button type="button" aria-label={`Aumentar ${line.product.name}`} onClick={() => setCart(current => current.map(item => item.key === line.key ? { ...item, quantity: Math.min(999, Number(item.quantity) + 1) } : item))} className="h-10 w-10 rounded-lg border border-slate-300 text-lg font-bold hover:bg-slate-50">+</button></span>
                    : <label className="flex items-center gap-1 text-xs text-slate-600">Peso (kg)<input type="number" step="0.001" min="0.001" max="999.999" value={line.weightKg} onChange={event => { const weight = Number(event.target.value); if (weight > 0) setCart(current => current.map(item => item.key === line.key ? { ...item, weightKg: Math.min(999.999, Math.round(weight * 1000) / 1000) } : item)); }} className="h-10 w-24 rounded-lg border border-slate-300 px-2 text-sm" /></label>}
                  <input aria-label={`Observação de ${line.product.name}`} placeholder="Observação" maxLength={200} value={line.notes} onChange={event => setCart(current => current.map(item => item.key === line.key ? { ...item, notes: event.target.value } : item))} className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-2 text-xs" />
                  <button type="button" aria-label={`Remover ${line.product.name}`} onClick={() => setCart(current => current.filter(item => item.key !== line.key))} className="h-10 w-10 rounded-lg border border-red-200 text-red-700 hover:bg-red-50">✕</button>
                </div>
              </li>)}
              {cart.length === 0 && <li className="py-6 text-center text-sm text-slate-500">Carrinho vazio. Toque em um produto para adicionar.</li>}
            </ul>

            {pdv.askSeller && <label className="block text-sm font-semibold text-slate-800">Vendedor
              <select aria-label="Vendedor" value={sellerId} onChange={event => { setSellerId(event.target.value); if (event.target.value) localStorage.setItem('rm_pdv_seller', event.target.value); }} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900">
                <option value="">Selecione o vendedor</option>{sellers.map(seller => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            </label>}

            <details className="rounded-xl border border-slate-200 p-3" open={Boolean(customer || customerName)}>
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">Cliente{customer ? `: ${customer.name}` : ''}</summary>
              <div className="mt-2 space-y-2">
                {customer
                  ? <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2 text-sm"><span>{customer.name} · {customer.phone}</span><button type="button" className="font-semibold text-brand-700" onClick={() => { setCustomer(null); setCustomerTerm(''); setCustomerName(''); }}>Trocar</button></div>
                  : <>
                    <Field label="Telefone ou nome" type="search" value={customerTerm} onChange={event => typeCustomer(event.target.value)} />
                    {customerResults.length > 0 && <ul className="rounded-lg border border-slate-200">{customerResults.map(item => <li key={item.id}><button type="button" className="block min-h-11 w-full px-3 text-left text-sm hover:bg-brand-50" onClick={() => { setCustomer(item); setCustomerResults([]); }}>{item.name} · {item.phone}</button></li>)}</ul>}
                    {customerTerm.trim().length >= 2 && customerResults.length === 0 && <><Field label="Nome do novo cliente" maxLength={160} value={customerName} onChange={event => setCustomerName(event.target.value)} /><p className="text-xs text-slate-500">{pdv.autoRegisterCustomer ? 'Se informar telefone e nome, o cliente é cadastrado automaticamente.' : 'Cadastro automático desativado: o nome vai apenas neste pedido.'}</p></>}
                  </>}
              </div>
            </details>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Cupom" maxLength={40} value={couponCode} onChange={event => setCouponCode(event.target.value.toUpperCase())} />
              <div><span className="block text-sm font-medium text-slate-700">{adjMode === 'DISCOUNT' ? 'Desconto' : 'Acréscimo'}</span>
                <div className="mt-1 flex gap-1"><input aria-label="Valor do ajuste" inputMode="decimal" value={adjValue} onChange={event => { setAdjValue(event.target.value); setReleaseId(''); }} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 px-2" placeholder="0,00" />
                  <button type="button" title="Alternar entre valor e porcentagem" aria-label={`Tipo: ${adjType === 'FIXED' ? 'valor em reais' : 'porcentagem'}`} onClick={() => { setAdjType(adjType === 'FIXED' ? 'PERCENT' : 'FIXED'); setReleaseId(''); }} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-bold">{adjType === 'FIXED' ? 'R$' : '%'}</button>
                  <button type="button" title="Alternar entre desconto e acréscimo" aria-label="Alternar desconto/acréscimo" onClick={() => { setAdjMode(adjMode === 'DISCOUNT' ? 'SURCHARGE' : 'DISCOUNT'); setReleaseId(''); }} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-bold">{adjMode === 'DISCOUNT' ? '−' : '+'}</button></div></div>
            </div>
            <label className="block text-sm font-medium text-slate-700">Observação do pedido<textarea rows={2} maxLength={300} value={observation} onChange={event => setObservation(event.target.value)} className={textareaClass} /></label>

            {isTable && <div className="space-y-2 rounded-xl bg-slate-50 p-3">
              <Check label={`Cobrar ${pdv.serviceFeeName}${feePercent ? ` (${feePercent}%)` : ''}`} checked={applyFee} onChange={event => setApplyFee(event.target.checked)} />
              {cover && <div><Field label={`Couvert: ${cover.description} (${formatMoney(cover.amount)}/pessoa) — nº de pessoas`} type="number" min="0" max="500" value={people} onChange={event => setPeople(event.target.value)} /></div>}
            </div>}
            {canSchedule && <div className="space-y-2 rounded-xl bg-slate-50 p-3">
              <Check label="Agendar pedido" checked={scheduleOn} onChange={event => setScheduleOn(event.target.checked)} />
              {scheduleOn && <Field label="Data e hora" type="datetime-local" min={minSchedule} value={scheduledFor} onChange={event => setScheduledFor(event.target.value)} />}
              {scheduleOn && <p className="text-xs text-slate-500">O pedido fica retido e só vai para a cozinha no horário de liberação.</p>}
            </div>}

            <dl className="space-y-1 border-t border-slate-200 pt-3 text-sm">
              <div className="flex justify-between"><dt className="text-slate-600">Sub-total</dt><dd>{formatMoney(subtotal)}</dd></div>
              {discountAmount > 0 && <div className="flex justify-between text-emerald-700"><dt>Desconto</dt><dd>− {formatMoney(discountAmount)}</dd></div>}
              {surchargeAmount > 0 && <div className="flex justify-between"><dt className="text-slate-600">Acréscimo</dt><dd>{formatMoney(surchargeAmount)}</dd></div>}
              {serviceFee > 0 && <div className="flex justify-between"><dt className="text-slate-600">{pdv.serviceFeeName}</dt><dd>{formatMoney(serviceFee)}</dd></div>}
              {couvert > 0 && <div className="flex justify-between"><dt className="text-slate-600">Couvert</dt><dd>{formatMoney(couvert)}</dd></div>}
              {deliveryFee > 0 && <div className="flex justify-between"><dt className="text-slate-600">Entrega</dt><dd>{formatMoney(deliveryFee)}</dd></div>}
              <div className="flex items-center justify-between rounded-xl bg-neutral-950 px-3 py-3 text-brand-300"><dt className="font-semibold">Valor total</dt><dd className="text-2xl font-black">{formatMoney(total)}</dd></div>
              {foreignTotals(Number(total), pdv).map(row => <div key={row.code} className="flex justify-between text-xs text-slate-600"><dt>{row.label}</dt><dd className="font-semibold">{row.value}</dd></div>)}
              <p className="text-[11px] text-slate-500">Estimativa. O servidor confirma cupom, promoções e taxas ao gerar.</p>
            </dl>

            <div className="grid gap-2 sm:grid-cols-2">
              {pdv.orderMode && <button type="button" disabled={busy || cart.length === 0} onClick={() => void submit('order')} className={`${secondaryButtonClass} min-h-14 text-base font-bold`}>{busy && !payOpen ? 'Enviando…' : 'Gerar pedido'}</button>}
              {pdv.saleMode && <button type="button" disabled={busy || cart.length === 0 || sessions === null || (sessions !== null && !openSession && !(pdv.showPixOnTerminal && methods.some(item => item.equivalent === 'PIX')))} onClick={() => void submit('sale')} title={sessions === null ? 'Seu perfil não registra pagamentos' : !openSession ? 'Abra o caixa para gerar vendas ou use PIX online' : undefined} className={`${buttonClass} min-h-14 text-base`}>Gerar venda</button>}
            </div>
            {sessions !== null && !openSession && sessions.length > 0 && <p className="text-xs text-amber-800">Não há caixa aberto para a unidade deste pedido. <Link href="/cash" className="font-semibold underline">Abrir caixa</Link></p>}
            {lastOrder && <div className="text-center text-xs text-slate-500"><p>Último: {orderTitle(lastOrder)} · <Link href={`/cash?orderId=${encodeURIComponent(lastOrder.id)}#pagamento`} className="font-semibold text-brand-700">pagar no caixa</Link></p>{settings?.ticket.enabled && pickupTicketItems(lastOrder).length > 0 && <button type="button" className="mt-2 font-semibold text-brand-700 underline" onClick={printPickupTicket}>Imprimir ticket de retirada</button>}</div>}
          </aside>
        </div>

        {config && <div role="dialog" aria-modal="true" aria-label={`Configurar ${config.product.name}`} className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onKeyDown={event => { if (event.key === 'Escape') setConfig(null); }}>
          <div className="rm-surface max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900">{config.product.name}</h3>
            <p className="text-sm text-slate-500">{formatMoney(unitPrice(config.product))}{config.product.soldByWeight ? ' por kg' : ''}</p>
            {config.product.allowFreePrice && !config.product.soldByWeight && <label className="mt-3 block text-sm font-medium text-slate-700">Preço deste item (R$)<input autoFocus type="number" inputMode="decimal" min="0" max="9999999999.99" step="0.01" value={config.unitPrice} onChange={event => setConfig({ ...config, unitPrice: event.target.value, error: '' })} className={`${inputClass} text-lg`} /></label>}
            {config.product.soldByWeight && <label className="mt-3 block text-sm font-medium text-slate-700">Peso (kg)<input autoFocus type="number" inputMode="decimal" step="0.001" min="0.001" max="999.999" value={config.weight} onChange={event => setConfig({ ...config, weight: event.target.value, error: '' })} className={`${inputClass} text-lg`} /></label>}
            {config.product.soldByWeight && Number(config.weight) > 0 && <p className="mt-1 text-sm font-semibold text-slate-700">Total do item: {formatMoney(round2(unitPrice(config.product) * Number(config.weight)))}</p>}
            {config.groups.length > 0 && <ModifierPicker large groups={config.groups} value={config.sel} onChange={sel => setConfig({ ...config, sel, error: '' })} />}
            {config.product.packagingEnabled && <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={config.withPackaging} onChange={event => setConfig({ ...config, withPackaging: event.target.checked })} className="h-4 w-4 accent-brand-600" />Adicionar embalagem {Number(config.product.packagingPrice) > 0 && `(+${formatMoney(config.product.packagingPrice)})`}</label>}
            {config.product.allowNotes !== false && <label className="mt-3 block text-sm font-medium text-slate-700">Observação<input maxLength={200} value={config.notes} onChange={event => setConfig({ ...config, notes: event.target.value })} className={inputClass} /></label>}
            {config.error && <p role="alert" className="mt-2 text-sm text-red-700">{config.error}</p>}
            <div className="mt-4 flex gap-2"><button type="button" className={`${buttonClass} min-h-12 flex-1`} onClick={confirmConfig}>Adicionar ao carrinho</button><button type="button" className={`${secondaryButtonClass} min-h-12`} onClick={() => setConfig(null)}>Cancelar</button></div>
          </div>
        </div>}

        {payOpen && <div role="dialog" aria-modal="true" aria-label="Forma de pagamento" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onKeyDown={event => { if (event.key === 'Escape') setPayOpen(false); }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900">Pagamento</h3>
            <p className="mt-1 text-3xl font-black text-slate-900">{formatMoney(total)}</p>
            <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Formas de pagamento">{methods.map(item => <button key={item.id} type="button" aria-pressed={method.id === item.id} onClick={() => setMethodId(item.id)} className={`min-h-12 rounded-xl border px-2 text-sm font-semibold transition ${method.id === item.id ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>{item.name}</button>)}</div>
            {method.allowChange && <div className="mt-3"><Field label="Valor recebido" inputMode="decimal" value={received} onChange={event => setReceived(event.target.value)} />{receivedValue > total && <p className="mt-1 text-sm font-semibold text-emerald-700">Troco: {formatMoney(receivedValue - total)}</p>}{receivedValue > 0 && receivedValue < total && <p className="mt-1 text-sm text-red-700">Valor recebido menor que o total.</p>}</div>}
            <p className="mt-3 text-xs text-slate-500">{pdv.showPixOnTerminal && method.equivalent === 'PIX' ? 'O PIX online será confirmado pelo provedor configurado; sem provedor, você poderá receber manualmente no Caixa.' : `O pagamento é registrado no caixa aberto${openSession ? '' : ' (nenhum encontrado!)'}. Maquininhas e PIX são confirmados manualmente.`}</p>
            <div className="mt-4 flex gap-2"><button type="button" disabled={busy || (method.allowChange && receivedValue > 0 && receivedValue < total)} className={`${buttonClass} min-h-12 flex-1`} onClick={() => void submit('sale')}>{busy ? 'Registrando…' : 'Confirmar venda'}</button><button type="button" className={`${secondaryButtonClass} min-h-12`} onClick={() => setPayOpen(false)}>Voltar</button></div>
          </div>
        </div>}
        {onlinePixOrderId && <div role="dialog" aria-modal="true" aria-label="Cobrança PIX no terminal" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-lg font-bold text-slate-900">PIX do pedido {lastOrder ? orderTitle(lastOrder) : ''}</h3><button type="button" className={secondaryButtonClass} onClick={() => setOnlinePixOrderId('')}>Fechar</button></div>
            <OnlineCharges key={onlinePixOrderId} orderId={onlinePixOrderId} onPaid={() => { setSuccess('Pagamento PIX confirmado pelo provedor.'); setOnlinePixOrderId(''); }} />
            <p className="mt-3 text-sm text-slate-600">A confirmação é recebida pelo servidor. Se nenhum provedor estiver configurado, feche esta janela e registre o pagamento manualmente no Caixa.</p>
          </div>
        </div>}
        {fiscalAsk && <FiscalChoiceDialog onChoose={emit => { setFiscalAsk(false); fiscalResolver.current?.(emit); fiscalResolver.current = null; }} />}
        {inutilOpen && <InutilizationDialog onClose={() => setInutilOpen(false)} />}
        <PasswordReleaseDialog key={releaseAction} open={releaseOpen} action={releaseAction} defaultReason={releaseAction === 'OTHER' ? 'PDV_TABLE_ORDER' : undefined} fixedReason={releaseAction === 'OTHER'} onCancel={() => setReleaseOpen(false)} onAuthorized={id => {
          setReleaseOpen(false);
          if (pendingRelease.current === 'ONLINE_ORDER') { setOrderReleaseId(id); void submit(pendingSubmit.current, releaseId, id); }
          else { setReleaseId(id); void submit(pendingSubmit.current, id, orderReleaseId); }
        }} />
      </div>
    </div>
    {lastOrder && printContent.receipt && <OrderReceipt order={lastOrder} serviceFeeName={pdv.serviceFeeName} printing={settings?.printing} company={settings?.company} />}
    {lastOrder && printContent.ticket && settings?.ticket.enabled && <PickupTicket order={lastOrder} printing={settings.printing} />}
  </AppShell>;
}
