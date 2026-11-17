import type { ModifierGroupView } from './api';
import type { Slot } from './settings';

export type StoreProduct = {
  id: string; name: string; description?: string | null; price: string | number; promoPrice?: string | number | null;
  isCombo?: boolean; soldByWeight?: boolean; favorite?: boolean;
  comboComponents?: { quantity: number; product: { name: string } }[]; modifierGroups?: ModifierGroupView[];
};
export type StoreCategory = { id: string | null; name: string; products: StoreProduct[] };
export type StoreZone = { id: string; name: string; fee: string | number; minOrder?: string | number | null };
export type StorePaymentMethod = { id: string; name: string; equivalent: string; allowChange: boolean };

// GET /public/store/:slug
export type StoreData = {
  restaurant: { name: string; slug: string };
  open: boolean;
  hours: { timezone: string; mode: 'OPEN' | 'CLOSED' | 'SCHEDULE'; weekly: Slot[] };
  fulfillment: { allowPickup: boolean; allowDelivery: boolean; estimatedTime: boolean; pickupMinutes: number; deliveryMinutes: number; deliveryFeeMode: 'SINGLE' | 'UNMAPPED' | 'ZONES' | 'DISTRICT'; singleFee: number; minDelivery: number; freeDeliveryMin: number };
  scheduling: { enabled: boolean; maxDaysAhead: number; leadTime: string; blockedFrom: string | null; blockedTo: string | null; slots: Slot[] };
  allowBuyWhenClosed: boolean;
  autoAccept: boolean;
  brandColor: string;
  metaPixelId: string | null;
  categories: StoreCategory[];
  deliveryZones: StoreZone[];
  paymentMethods: StorePaymentMethod[];
};

// POST /public/store/:slug/orders
export type StoreOrderResult = { code: string; number: number | null; total: string | number; deliveryFee: string | number; scheduledFor: string | null; autoAccept: boolean };
