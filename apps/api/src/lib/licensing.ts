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
  { key: 'intelligence', name: 'RM Inteligência' },
  { key: 'profit', name: 'RM Controle de Lucro' },
] as const;

export type ModuleKey = typeof MODULE_CATALOG[number]['key'];
export const MODULE_KEYS = MODULE_CATALOG.map(item => item.key) as [ModuleKey, ...ModuleKey[]];

const ROUTE_MODULES: Record<string, ModuleKey> = {
  orders: 'pos', tables: 'tables', reservations: 'tables', delivery: 'delivery', inventory: 'inventory', purchasing: 'inventory',
  financial: 'financial', 'bank-reconciliation': 'financial', cash: 'financial', employees: 'employees', shifts: 'employees', commissions: 'employees', production: 'kds', printing: 'printing',
  whatsapp: 'whatsapp', coupons: 'marketing', fiscal: 'fiscal', reports: 'reports', integrations: 'integrations', payments: 'integrations',
  releases: 'pos', scale: 'pos', couriers: 'delivery', carriers: 'inventory', 'payment-methods': 'financial', 'financial-categories': 'financial',
  promotions: 'marketing', 'cover-events': 'tables', 'table-requests': 'tables', 'tax-rules': 'fiscal', 'fiscal-registry': 'fiscal',
  intelligence: 'intelligence', profit: 'profit', pricing: 'profit', tef: 'integrations',
};

// API route prefixes that belong to a module (what the license gate protects); shown in the admin panel so the link is never typed by hand.
export const routesOfModule = (key: string) => Object.entries(ROUTE_MODULES).filter(([, module]) => module === key).map(([route]) => `/${route}`).sort();

export function moduleForPath(originalUrl: string): ModuleKey | null {
  const segment = originalUrl.split('?')[0].match(/^\/api\/v1\/([^/]+)/)?.[1];
  return segment ? ROUTE_MODULES[segment] ?? null : null;
}

export type LicenseSnapshot = { status: LicenseStatus; validUntil: Date | null; graceDays?: number } | null;
export type ModuleGrant = { moduleKey: string; blocked?: boolean; startsAt?: Date | null; endsAt?: Date | null };

// Single entitlement rule: a granted module is usable inside its dates, when not blocked for the tenant and not blocked globally in the catalog.
export function effectiveModules(grants: ModuleGrant[], globallyBlocked: ReadonlySet<string> | string[] = [], now = new Date()): string[] {
  const blocked = new Set(globallyBlocked);
  return grants
    .filter(grant => !grant.blocked && !blocked.has(grant.moduleKey) && (!grant.startsAt || grant.startsAt <= now) && (!grant.endsAt || grant.endsAt >= now))
    .map(grant => grant.moduleKey);
}

let blockedCache: { keys: Set<string>; at: number } | null = null;
export function invalidateBlockedModules() { blockedCache = null; }
// Short-lived cache so the per-request license check does not add a catalog query to every call.
export async function globallyBlockedModules(load: () => Promise<string[]>, now = Date.now()): Promise<Set<string>> {
  if (blockedCache && now - blockedCache.at < 15_000) return blockedCache.keys;
  blockedCache = { keys: new Set(await load()), at: now };
  return blockedCache.keys;
}

// Tenants without a license row predate licensing and keep unrestricted access; data is never removed, only access is gated.
export function licenseDenial(license: LicenseSnapshot, enabledModules: string[], originalUrl: string, now = new Date()): string | null {
  if (!license) return null;
  // A restaurant must always be able to reach support, even with a suspended or expired license.
  if (/^\/api\/v1\/support(?:[/?]|$)/.test(originalUrl)) return null;
  if (license.status !== LicenseStatus.ACTIVE) return 'License is not active';
  const graceMs = (license.graceDays ?? 0) * 86_400_000;
  if (license.validUntil && license.validUntil.getTime() + graceMs < now.getTime()) return 'License expired';
  const required = moduleForPath(originalUrl);
  if (required && !enabledModules.includes(required)) return `Module not included in the license: ${required}`;
  return null;
}
