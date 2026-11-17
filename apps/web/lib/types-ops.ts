import type { Order, OrderItemModifier } from './api';

export type OpsOrderItem = {
  id: string;
  quantity: number | string;
  weightKg?: string | number | null;
  unitPrice?: string | number;
  total?: string | number;
  withPackaging?: boolean;
  packagingPrice?: string | number;
  notes?: string | null;
  status?: string;
  parentItemId?: string | null;
  product: { id?: string; name: string; pickupTicket?: boolean; packagingEnabled?: boolean; packagingPrice?: string | number };
  modifiers?: OrderItemModifier[];
};

export type OpsPayment = { id: string; amount: string | number; method: string };
export type OpsDeliveryJob = { id: string; status: 'PENDING' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELLED'; courierId?: string | null; courierName?: string | null; courierPhone?: string | null; address?: string | null; dispatchedAt?: string | null };
export type OpsFiscalDocument = { id: string; status: 'PENDING' | 'AUTHORIZED'; series?: string | null; number?: string | null; documentUrl?: string | null };

export type OpsOrder = Omit<Order, 'items'> & {
  number?: number | null;
  unitId?: string | null;
  tableId?: string | null;
  scheduledFor?: string | null;
  releaseAt?: string | null;
  releasedAt?: string | null;
  couvertFee?: string | number;
  customer?: { id: string; name: string; phone: string } | null;
  payments?: OpsPayment[];
  deliveryJob?: OpsDeliveryJob | null;
  deliveryZone?: { id: string; name: string } | null;
  fiscalDocuments?: OpsFiscalDocument[];
  items: OpsOrderItem[];
};

export type OpsCustomer = { id: string; name: string; phone: string };
export type OpsTable = { id: string; unitId: string; label: string; seats: number; active: boolean };
export type OpsZone = { id: string; name: string; fee: string | number; minOrder?: string | number | null; active: boolean };
export type OpsProduct = {
  id: string; name: string; code?: string | null; barcode?: string | null; description?: string | null; price: string | number; active: boolean; isCombo?: boolean; favorite?: boolean;
  soldByWeight?: boolean; allowFractionalQuantity?: boolean; packagingEnabled?: boolean; packagingPrice?: string | number; scaleCode?: number | null; unitId?: string | null; category?: { id: string; name: string } | null; categoryId?: string | null; allowNotes?: boolean; allowFreePrice?: boolean; alwaysShowDescription?: boolean;
};
export type OpsPromotion = { id: string; type: 'PERCENT' | 'FIXED'; value: string | number; startsAt: string; endsAt?: string | null; active: boolean; products?: { productId: string }[]; productIds?: string[] };
export type PaymentMethodOption = { id: string; name: string; equivalent: 'CASH' | 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'VOUCHER' | 'OTHER'; allowChange: boolean; showLocal?: boolean; showStore?: boolean; showApp?: boolean };
export type CoverEventNow = { id: string; description: string; amount: string | number; startsAt: string; endsAt: string };
export type OpsCashSession = { id: string; unitId?: string | null; status: 'OPEN' | 'CLOSED' };
export type ScaleLookup = { product: { id: string; name: string; price: string | number; scaleCode?: number | null; soldByWeight: boolean }; kind: 'WEIGHT' | 'PRICE'; weightKg?: string; total?: string };

export const DEFAULT_PAYMENT_METHODS: PaymentMethodOption[] = [
  { id: 'default-cash', name: 'Dinheiro', equivalent: 'CASH', allowChange: true },
  { id: 'default-pix', name: 'PIX', equivalent: 'PIX', allowChange: false },
  { id: 'default-credit', name: 'Cartão de crédito', equivalent: 'CREDIT_CARD', allowChange: false },
  { id: 'default-debit', name: 'Cartão de débito', equivalent: 'DEBIT_CARD', allowChange: false },
  { id: 'default-voucher', name: 'Vale / voucher', equivalent: 'VOUCHER', allowChange: false },
  { id: 'default-other', name: 'Outros', equivalent: 'OTHER', allowChange: false },
];

export const channelLabels: Record<string, string> = { POS: 'Balcão', TAKEAWAY: 'Retirada', DELIVERY: 'Entrega', TABLE: 'Mesa / comanda', WHATSAPP: 'WhatsApp' };
export const statusLabels: Record<string, string> = { OPEN: 'Aceito', PREPARING: 'Em preparo', READY: 'Pronto', COMPLETED: 'Finalizado', CANCELLED: 'Cancelado' };
export const methodLabels: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Crédito', DEBIT_CARD: 'Débito', VOUCHER: 'Voucher', OTHER: 'Outros' };

const orderErrors: Record<string, string> = {
  SCHEDULING_DISABLED: 'O agendamento de pedidos está desativado nas configurações.',
  SCHEDULE_TOO_SOON: 'Horário muito próximo: agende com pelo menos 5 minutos de antecedência.',
  SCHEDULE_TOO_FAR: 'Data além do limite de dias de antecedência permitido.',
  SCHEDULE_BLOCKED: 'Não há agendamentos neste período (datas bloqueadas).',
  SCHEDULE_OUTSIDE_SLOTS: 'Horário fora das janelas de agendamento configuradas.',
  SCHEDULE_NOT_FOR_TABLE: 'Pedidos de mesa/comanda não podem ser agendados.',
  WEIGHT_REQUIRED: 'Informe o peso (kg) do produto vendido por peso.',
  WEIGHT_NOT_ALLOWED: 'Este produto não é vendido por peso.',
  FRACTIONAL_QUANTITY_NOT_ALLOWED: 'Este produto não permite quantidade fracionada.',
  PRODUCTS_UNAVAILABLE: 'Algum produto do carrinho não está mais disponível.',
  MODIFIER_UNAVAILABLE: 'Algum adicional escolhido não está mais disponível.',
  MODIFIER_SELECTION_INVALID: 'A seleção de adicionais não atende às regras do produto.',
  COMBO_UNAVAILABLE: 'Um item do combo está indisponível.',
  TABLE_UNAVAILABLE: 'Mesa indisponível.',
  INVALID_PHONE: 'Telefone do cliente inválido.',
  COUPON_UNAVAILABLE: 'Cupom inválido, vencido ou esgotado.',
  DELIVERY_ZONE_UNAVAILABLE: 'Zona de entrega indisponível.',
  DELIVERY_ZONE_ONLY_FOR_DELIVERY: 'Zona de entrega só vale para pedidos de entrega.',
  BELOW_DELIVERY_MINIMUM: 'Pedido abaixo do mínimo da zona de entrega.',
  COUVERT_ONLY_FOR_TABLE: 'O couvert só se aplica a mesa/comanda.',
  COUVERT_UNAVAILABLE: 'Não há evento com couvert vigente agora.',
  DISCOUNT_EXCEEDS_TOTAL: 'O desconto não pode ser maior que o total do pedido.',
  DISCOUNT_RELEASE_REQUIRED: 'Desconto exige liberação com a senha do administrador.',
  UNIT_UNAVAILABLE: 'Unidade indisponível.',
  'Scheduled order has not been released yet': 'Pedido agendado ainda não foi liberado para produção.',
  'Insufficient stock to start preparing this order': 'Estoque insuficiente para iniciar o preparo.',
  'Order is not waiting for release': 'O pedido não está aguardando liberação.',
  'Only held scheduled orders can be rescheduled': 'Só é possível reagendar pedidos retidos.',
  'Invalid order status transition': 'Transição de status inválida para este pedido.',
  ORDER_NOT_FOUND: 'Pedido não encontrado.',
  ORDER_CLOSED: 'Pedidos concluídos ou cancelados não podem ser editados.',
  PAYMENTS_EXCEED_TOTAL: 'Os pagamentos já registrados superam o novo total. Estorne um pagamento no caixa antes de reduzir o pedido.',
  PAYMENT_NOT_FOUND: 'Pagamento não encontrado neste pedido.',
  DELIVERY_ONLY: 'Endereço, zona e taxa de entrega só valem para pedidos de entrega.',
  CUSTOMER_NAME_REQUIRED: 'Informe o nome do cliente junto com o telefone.',
  'Refund confirmed payments before cancelling this order': 'Estorne os pagamentos confirmados antes de cancelar o pedido.',
  'Payment exceeds the remaining order balance': 'O pagamento excede o saldo do pedido.',
  'Invalid or closed cash session': 'Caixa inválido ou fechado.',
  'Insufficient permissions': 'Seu perfil não tem permissão para esta ação.',
};

// API reasons are stable codes; translate them for the counter staff and fall back to the raw message.
export function opsError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return orderErrors[message] ?? (message || fallback);
}

export const orderTitle = (order: { number?: number | null; code: string }) => order.number ? `#${order.number}` : order.code;

export function lineWeight(item: { weightKg?: string | number | null }) {
  return item.weightKg !== null && item.weightKg !== undefined && Number(item.weightKg) > 0 ? `${Number(item.weightKg).toFixed(3).replace('.', ',')} kg` : null;
}

export function lineText(item: OpsOrderItem) {
  const weight = lineWeight(item);
  const extras = item.modifiers?.length ? ` (${item.modifiers.map(modifier => `${modifier.quantity}× ${modifier.name}`).join(', ')})` : '';
  return `${item.quantity}× ${item.product.name}${weight ? ` · ${weight}` : ''}${item.withPackaging ? ' · Embalagem' : ''}${extras}`;
}

export function elapsedLabel(from: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export const isHeld = (order: Pick<OpsOrder, 'scheduledFor' | 'releasedAt'>) => Boolean(order.scheduledFor) && !order.releasedAt;
export const paidTotal = (order: Pick<OpsOrder, 'payments'>) => (order.payments ?? []).reduce((sum, payment) => sum + Number(payment.amount), 0);
export const isTabOrder = (order: Pick<OpsOrder, 'channel' | 'tableLabel'>) => order.channel === 'TABLE' || Boolean(order.tableLabel);

export function toLocalInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dayKey(value: string) { return toLocalInput(new Date(value)).slice(0, 10); }
export function dayTitle(key: string) { return new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }); }
export function timeOf(value?: string | null) { return value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'; }

export function promoPrice(product: Pick<OpsProduct, 'id' | 'price'>, promotions: OpsPromotion[], now = Date.now()) {
  const price = Number(product.price);
  let best = price;
  for (const promotion of promotions) {
    const ids = promotion.productIds ?? promotion.products?.map(link => link.productId) ?? [];
    if (!promotion.active || !ids.includes(product.id) || new Date(promotion.startsAt).getTime() > now || (promotion.endsAt && new Date(promotion.endsAt).getTime() < now)) continue;
    const reduction = promotion.type === 'PERCENT' ? price * Number(promotion.value) / 100 : Number(promotion.value);
    best = Math.min(best, Math.max(0, Math.round((price - reduction) * 100) / 100));
  }
  return best;
}
