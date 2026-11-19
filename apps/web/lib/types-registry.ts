export type Courier = { id: string; name: string; phone?: string | null; paymentPerDelivery?: string | number | null; commissionPercent?: string | number | null; unitId?: string | null; active: boolean; createdAt?: string };
export type Carrier = { id: string; name: string; document?: string | null; phone?: string | null; email?: string | null; notes?: string | null; active: boolean; createdAt?: string };

export type PaymentEquivalent = 'CASH' | 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'VOUCHER' | 'OTHER';
export type PaymentMethodConfig = { id: string; name: string; equivalent: PaymentEquivalent; active: boolean; showLocal: boolean; showStore: boolean; showApp: boolean; allowChange: boolean; requireDocument: boolean; sortOrder: number };

export type FinancialCategoryType = 'INCOME' | 'EXPENSE';
export type FinancialCategory = { id: string; type: FinancialCategoryType; name: string; active: boolean };

export type CoverEvent = { id: string; description: string; amount: string | number; startsAt: string; endsAt: string; unitId?: string | null; active: boolean };

export type TaxRule = {
  id: string; name: string; ncm?: string | null; cest?: string | null; origin: number; cfop?: string | null; cfopInterstate?: string | null;
  icmsCst?: string | null; icmsRate?: string | number | null; icmsReduction?: string | number | null;
  pisCst?: string | null; pisRate?: string | number | null; cofinsCst?: string | null; cofinsRate?: string | number | null;
  active: boolean; _count?: { products: number };
};
export type TaxRuleProduct = { id: string; name: string; code?: string | null; price: string | number; active: boolean; ncm?: string | null; category?: { id: string; name: string } | null };

export type DeleteResult = { deleted: boolean; deactivated: boolean };

export const paymentEquivalentLabels: Record<PaymentEquivalent, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito', DEBIT_CARD: 'Cartão de débito', VOUCHER: 'Vale', OTHER: 'Outro' };

export function formatDocument(value?: string | null) {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return value ?? '';
}

// Value for <input type="datetime-local"> from an ISO string, in the browser's timezone.
export function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
