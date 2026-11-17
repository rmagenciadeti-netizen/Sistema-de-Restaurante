const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path: string, options: RequestInit, withToken: boolean): Promise<T> {
  const token = withToken && typeof window !== 'undefined' ? localStorage.getItem('rm_restaurant_token') : null;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message ?? 'Falha ao comunicar com a API', response.status);
  return payload as T;
}

export function api<T>(path: string, options: RequestInit = {}): Promise<T> { return request<T>(path, options, true); }
// Public endpoints (customer QR menu) must never carry the staff token.
export function publicApi<T>(path: string, options: RequestInit = {}): Promise<T> { return request<T>(path, options, false); }

export function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
export function formatMoney(value: string | number | null | undefined) { return `R$ ${Number(value ?? 0).toFixed(2).replace('.', ',')}`; }
export function formatDateTime(value?: string | null) { return value ? new Date(value).toLocaleString('pt-BR') : '—'; }
export function toIso(localValue: string) { return localValue ? new Date(localValue).toISOString() : undefined; }
export function storedUser(): { unitId?: string | null; role?: string } {
  try { return JSON.parse(localStorage.getItem('rm_restaurant_user') ?? '{}'); } catch { return {}; }
}

export type ListResponse<T> = { items: T[]; total: number; page?: number; pageSize?: number };
export type Unit = { id: string; name: string; code?: string | null; address?: string | null; status: string };
export type Employee = { id: string; fullName: string; cpf?: string | null; phone?: string | null; email?: string | null; position?: string | null; status: string; unitId?: string | null };
export type Sector = { id: string; name: string };
export type Product = { id: string; name: string; isCombo?: boolean; code?: string | null; price: string | number; cost?: string | number | null; active: boolean; category?: { name: string } | null; sector?: Sector | null; unitId?: string | null };
export type Order = { id: string; code: string; channel: string; status: string; customerName?: string | null; tableLabel?: string | null; subtotal?: string | number; discount?: string | number; serviceFee?: string | number; deliveryFee?: string | number; total: string | number; createdAt: string; items: { id: string; quantity: number; product: { name: string }; modifiers?: OrderItemModifier[] }[] };
export type Tenant = { id: string; name: string; slug: string; plan: string; status: string; _count?: { units: number; users: number } };

export type ProductionSector = { id: string; name: string; code?: string | null; color?: string | null; description?: string | null; sortOrder: number; avgPrepMinutes?: number | null; autoPrint: boolean; showOnKds: boolean; active: boolean; unitId?: string | null };
export type Printer = { id: string; name: string; kind: 'KITCHEN' | 'RECEIPT' | 'LABEL'; connectionType: 'NETWORK' | 'USB' | 'SHARED' | 'SERIAL'; address?: string | null; port?: number | null; paperWidthMm: number; sectorId?: string | null; sector?: { id: string; name: string } | null; isPrimary: boolean; autoCut: boolean; cashDrawer: boolean; active: boolean };
export type PrintAgent = { id: string; name: string; unitId?: string | null; active: boolean; lastSeenAt?: string | null; createdAt?: string };
export type PrintJob = { id: string; kind: string; status: string; attempts: number; error?: string | null; createdAt: string; printedAt?: string | null; printer?: { id: string; name: string } | null; sector?: { id: string; name: string } | null };
export type OrderItemModifier = { id: string; name: string; price: string | number; quantity: number };
export type KdsItem = { id: string; modifiers?: OrderItemModifier[]; parentItem?: { product: { name: string } } | null; quantity: number; notes?: string | null; status: 'PENDING' | 'PREPARING' | 'READY'; createdAt: string; product: { name: string; sector?: { id: string; name: string } | null }; order: { id: string; code: string; channel: string; tableLabel?: string | null; customerName?: string | null; createdAt: string } };
export type RestaurantTable = { id: string; unitId: string; label: string; seats: number; qrToken: string; active: boolean };
export type PublicMenu = { restaurant: string; unit: string; table: string; serviceFeePercent: string | number; categories: { id: string | null; name: string; products: PublicProduct[] }[] };
export type PublicOrderResult = { id: string; code: string; status: string; total: string | number; serviceFee: string | number };
export type Customer = { id: string; name: string; phone: string; email?: string | null; document?: string | null; address?: string | null; notes?: string | null; marketingConsent: boolean; loyaltyPoints: number; createdAt: string; orders?: { id: string; code: string; channel: string; status: string; total: string | number; createdAt: string }[] };
export type Coupon = { id: string; code: string; type: 'PERCENT' | 'FIXED'; value: string | number; minOrder?: string | number | null; maxUses?: number | null; usedCount: number; validFrom?: string | null; validUntil?: string | null; active: boolean };
export type Reservation = { id: string; unitId: string; tableId?: string | null; table?: { id: string; label: string } | null; customerName: string; phone?: string | null; partySize: number; reservedAt: string; status: 'PENDING' | 'CONFIRMED' | 'SEATED' | 'CANCELLED' | 'NO_SHOW'; notes?: string | null };
export type Supplier = { id: string; name: string; document?: string | null; phone?: string | null; email?: string | null };
export type Ingredient = { id: string; name: string; unitOfMeasure: string; currentStock: string | number; minimumStock?: string | number | null };
export type PurchaseOrder = { id: string; code: string; status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'; total: string | number; dueAt?: string | null; createdAt: string; supplier: { id: string; name: string }; items: { id: string; quantity: string | number; unitCost: string | number; ingredient: { id: string; name: string; unitOfMeasure: string } }[] };
export type InventoryAdjustment = { ingredientId: string; name: string; previous: string | number; counted: string | number; difference: string | number };
export type DeliveryZone = { id: string; name: string; fee: string | number; minOrder?: string | number | null; active: boolean };
export type DeliveryJob = { id: string; orderId: string; courierName?: string | null; courierPhone?: string | null; address?: string | null; status: 'PENDING' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELLED'; provider?: string | null; createdAt: string; order?: Order };

export type ModifierOption = { id: string; name: string; price: string | number; active?: boolean; sectorId?: string | null };
export type ModifierGroupView = { id: string; name: string; minSelect: number; maxSelect: number; options: ModifierOption[] };
export type ModifierGroup = ModifierGroupView & { active: boolean; products?: { productId: string }[] };
export type ProductComposition = { id: string; name: string; isCombo: boolean; comboComponents: { quantity: number; product: { id: string; name: string } }[]; modifierGroups: { groupId: string }[] };
export type PublicProduct = { id: string; name: string; description?: string | null; price: string | number; isCombo?: boolean; comboComponents?: { quantity: number; product: { name: string } }[]; modifierGroups?: ModifierGroupView[] };
