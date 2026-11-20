import type { UserRole } from '@prisma/client';

export type RoleSet = 'ALL' | 'SALES' | 'CASH' | 'FINANCE' | 'MANAGEMENT' | 'DELIVERY' | 'PRODUCTION' | 'ADMIN';

export type Procedure = {
  id: string;
  title: string;
  // Words people use for this task (matched without accents/case); the title and the screen's own labels are matched too.
  aliases: string[];
  // Screen (apps/web/app/<name>) and the real menu entry (href exactly as in menu-catalog) that opens it.
  href: string;
  menuHref: string;
  // Tab/section of the screen, when the procedure happens inside one (must exist in the generated screen index).
  tab?: string;
  summary: string;
  steps: string[];
  // Field labels must exist on the screen (or on `alsoScreens`) — the test fails when the real form changes and this text did not.
  fields: { label: string; help: string; screen?: string }[];
  buttons?: string[];
  verify: string[];
  mistakes: string[];
  related?: string[];
  // Licensed module that unlocks the screen (same keys as the commercial catalog); omitted for core screens.
  module?: string;
  view: RoleSet; edit: RoleSet;
};

export const ROLE_LABELS: Record<string, string> = { ADMIN: 'Administrador', MANAGER: 'Gerente', CASHIER: 'Caixa', WAITER: 'Garçom', KITCHEN: 'Cozinha', DELIVERY: 'Entregador', FINANCE: 'Financeiro', SUPPORT: 'Suporte' };
export type RoleGroups = Record<RoleSet, UserRole[]>;
