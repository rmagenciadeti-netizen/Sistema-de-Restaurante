import { LicenseStatus } from '@prisma/client';

// Modules sold individually. Anything not listed in ROUTE_MODULES (auth, units, users, dashboard, audit, catalog, products, customers) is core.
export const MODULE_CATALOG = [
  { key: 'pos', name: 'PDV e Pedidos' },
  { key: 'tables', name: 'Gestão de Mesas e Reservas' },
  { key: 'delivery', name: 'Delivery' },
  { key: 'inventory', name: 'Estoque e Compras' },
  { key: 'financial', name: 'Financeiro e Caixas' },
  { key: 'employees', name: 'Funcionários, Escalas e Comissões' },
  { key: 'kds', name: 'KDS e Setores de Produção' },
  { key: 'printing', name: 'Impressão' },
  { key: 'whatsapp', name: 'WhatsApp' },
  { key: 'marketing', name: 'Cupons e Promoções' },
  { key: 'fiscal', name: 'Documentos Fiscais' },
  { key: 'reports', name: 'Relatórios Avançados' },
  { key: 'integrations', name: 'Integrações e Pagamentos' },
] as const;

export type ModuleKey = typeof MODULE_CATALOG[number]['key'];
export const MODULE_KEYS = MODULE_CATALOG.map(item => item.key) as [ModuleKey, ...ModuleKey[]];

const ROUTE_MODULES: Record<string, ModuleKey> = {
  orders: 'pos', tables: 'tables', reservations: 'tables', delivery: 'delivery', inventory: 'inventory', purchasing: 'inventory',
  financial: 'financial', cash: 'financial', employees: 'employees', shifts: 'employees', production: 'kds', printing: 'printing',
  whatsapp: 'whatsapp', coupons: 'marketing', fiscal: 'fiscal', reports: 'reports', integrations: 'integrations', payments: 'integrations',
  releases: 'pos', scale: 'pos', couriers: 'delivery', carriers: 'inventory', 'payment-methods': 'financial', 'financial-categories': 'financial',
  promotions: 'marketing', 'cover-events': 'tables', 'tax-rules': 'fiscal', 'fiscal-registry': 'fiscal',
};

export function moduleForPath(originalUrl: string): ModuleKey | null {
  const segment = originalUrl.split('?')[0].match(/^\/api\/v1\/([^/]+)/)?.[1];
  return segment ? ROUTE_MODULES[segment] ?? null : null;
}

export type LicenseSnapshot = { status: LicenseStatus; validUntil: Date | null } | null;

// Tenants without a license row predate licensing and keep unrestricted access; data is never removed, only access is gated.
export function licenseDenial(license: LicenseSnapshot, enabledModules: string[], originalUrl: string, now = new Date()): string | null {
  if (!license) return null;
  if (license.status !== LicenseStatus.ACTIVE) return 'License is not active';
  if (license.validUntil && license.validUntil.getTime() < now.getTime()) return 'License expired';
  const required = moduleForPath(originalUrl);
  if (required && !enabledModules.includes(required)) return `Module not included in the license: ${required}`;
  return null;
}
