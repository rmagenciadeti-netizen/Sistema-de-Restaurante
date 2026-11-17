import type { Product } from './api';

export type CatalogProduct = Product & {
  barcode?: string | null; favorite?: boolean; soldByWeight?: boolean; sendToScale?: boolean; scaleCode?: number | null;
  scaleDepartment?: number | null; shelfLifeDays?: number | null; scaleNotes?: string | null; ncm?: string | null; cest?: string | null; taxRuleId?: string | null;
  description?: string | null; prepTimeMinutes?: number | null; image?: { updatedAt: string } | null;
};

export type TaxRuleOption = { id: string; name: string; ncm?: string | null; cest?: string | null; active?: boolean };

export const SCALE_BRAND_OPTIONS = [
  { value: 'TOLEDO', label: 'Toledo' }, { value: 'FILIZOLA', label: 'Filizola' }, { value: 'URANO', label: 'Urano' }, { value: 'URANO_URF32', label: 'Urano URF32' },
] as const;
export type ScaleBrandValue = typeof SCALE_BRAND_OPTIONS[number]['value'];

export type ScaleProduct = { id: string; name: string; price: string | number; scaleCode: number | null; soldByWeight: boolean; scaleDepartment: number | null; shelfLifeDays: number | null; scaleNotes: string | null };

export type PromotionStatus = 'ACTIVE' | 'SCHEDULED' | 'INACTIVE' | 'EXPIRED';
export type Promotion = {
  id: string; name: string; type: 'PERCENT' | 'FIXED'; value: string | number; startsAt: string; endsAt: string | null; active: boolean; createdAt: string;
  status: PromotionStatus; products: { id: string; name: string; price: string | number }[];
};

export type ScheduleWindow = { weekday: number; startMinute: number; endMinute: number };
export type CategorySchedule = { categoryId: string; categoryName: string; windows: ScheduleWindow[] };

export type AdjustMode = 'SET' | 'INCREASE_PERCENT' | 'DECREASE_PERCENT' | 'ADD' | 'SUBTRACT' | 'COST_MARGIN';
export type AdjustRounding = 'NONE' | 'UP_10C' | 'NEAREST_50C' | 'ROUND_1';
export type BulkAdjustItem = {
  id: string; name: string; category: string | null; active: boolean; priceBefore: string; costBefore: string | null;
  priceAfter: string | null; costAfter: string | null; skipped: boolean; skipCode: string | null; reason: string | null;
};
export type BulkAdjustPreview = { items: BulkAdjustItem[]; total: number; changed: number; skipped: number };
