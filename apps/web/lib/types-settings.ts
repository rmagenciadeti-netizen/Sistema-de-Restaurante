import type { Slot } from './settings';

export type ReleaseAction = 'CANCEL_ORDER' | 'DISCOUNT' | 'CASH_WITHDRAWAL' | 'CLOSE_CASH' | 'OTHER';

export const releaseActionLabels: Record<ReleaseAction, string> = {
  CANCEL_ORDER: 'Cancelamento de pedido',
  DISCOUNT: 'Desconto',
  CASH_WITHDRAWAL: 'Sangria de caixa',
  CLOSE_CASH: 'Fechamento de caixa',
  OTHER: 'Outra liberação',
};

export type PasswordReleaseRow = {
  id: string;
  action: ReleaseAction | string;
  orderId?: string | null;
  orderCode?: string | null;
  orderNumber?: number | null;
  requestedByUserId: string;
  requestedByName?: string | null;
  reason?: string | null;
  createdAt: string;
};

export type ReleaseResult = { id: string; authorizedAt: string };
export type OrderStatusItem = { key: string; title: string; active: boolean };
export type { Slot };
