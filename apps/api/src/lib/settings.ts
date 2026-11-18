import { Prisma } from '@prisma/client';
import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const weekday = z.number().int().min(0).max(6);
const slot = z.object({ day: weekday, start: hhmm, end: hhmm });

export const APPEARANCE_MODES = ['LIGHT', 'DARK', 'AUTO'] as const;
export const APPEARANCE_PRIMARIES = ['GOLD', 'BLUE', 'GREEN', 'RED', 'YELLOW', 'PURPLE', 'ORANGE'] as const;
export const APPEARANCE_SIDEBARS = ['BLACK', 'WHITE', 'GRAY', 'GRAPHITE', 'NAVY', 'FOREST'] as const;
export const appearancePreferenceSchema = z.object({ mode: z.enum(APPEARANCE_MODES), primary: z.enum(APPEARANCE_PRIMARIES), sidebar: z.enum(APPEARANCE_SIDEBARS) });

export const SETTINGS_SECTIONS = {
  company: z.object({
    legalName: z.string().max(160).default(''), tradeName: z.string().max(160).default(''), document: z.string().max(20).default(''), activity: z.string().max(80).default(''),
    slogan: z.string().max(120).default(''), phone: z.string().max(30).default(''), whatsapp: z.string().max(30).default(''), zip: z.string().max(10).default(''),
    dpoName: z.string().max(120).default(''), dpoEmail: z.string().trim().email().or(z.literal('')).default(''),
    sidebarLayout: z.enum(['CLASSIC', 'COMPACT']).default('CLASSIC'),
    state: z.string().max(2).default(''), city: z.string().max(80).default(''), district: z.string().max(80).default(''), address: z.string().max(160).default(''), number: z.string().max(10).default(''),
  }),
  hours: z.object({
    timezone: z.string().max(60).default('America/Sao_Paulo'),
    mode: z.enum(['OPEN', 'CLOSED', 'SCHEDULE']).default('OPEN'),
    weekly: z.array(slot).max(70).default([]),
  }),
  fulfillment: z.object({
    allowPickup: z.boolean().default(true), allowDelivery: z.boolean().default(true), allowDineIn: z.boolean().default(true),
    estimatedTime: z.boolean().default(false), pickupMinutes: z.number().int().min(0).max(600).default(30), deliveryMinutes: z.number().int().min(0).max(600).default(50),
    deliveryFeeMode: z.enum(['SINGLE', 'UNMAPPED', 'ZONES', 'DISTRICT']).default('ZONES'),
    singleFee: z.number().min(0).max(9999).default(0), minDelivery: z.number().min(0).max(99999).default(0), freeDeliveryMin: z.number().min(0).max(99999).default(0),
  }),
  store: z.object({
    allowBuyWhenClosed: z.boolean().default(false), autoAccept: z.boolean().default(true), brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#b89235'),
    mode: z.enum(['MENU', 'ECOMMERCE']).default('MENU'), minorControl: z.boolean().default(false),
    metaPixelId: z.string().trim().regex(/^(\d{8,20})?$/, 'O ID do Pixel deve ter de 8 a 20 dígitos').default(''),
  }),
  pdv: z.object({
    layout: z.enum(['FOOD', 'RETAIL']).default('FOOD'), side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
    orderMode: z.boolean().default(true), saleMode: z.boolean().default(true), whatsappNotify: z.boolean().default(true), autoRegisterCustomer: z.boolean().default(true),
    tableControl: z.enum(['TABLES', 'TABS', 'TABLES_AND_TABS', 'TABLES_AND_ORDERS']).default('TABLES_AND_TABS'),
    askSeller: z.boolean().default(false), serviceFeeName: z.string().max(40).default('Taxa de serviço'),
    defaultOrderStatus: z.enum(['OPEN', 'PREPARING']).default('OPEN'),
    requireAdminPasswordOnline: z.boolean().default(false), showPixOnTerminal: z.boolean().default(false),
    // Reference rates for showing the total in foreign currency at the terminal: R$ per US$ and pesos per R$. 0 = off. Display only; orders are always in R$.
    usdRate: z.number().min(0).max(1000).default(0), pesoRate: z.number().min(0).max(1_000_000).default(0),
  }),
  scale: z.object({
    enabled: z.boolean().default(false), prefix: z.string().regex(/^\d{1,2}$/).default('2'),
    codeLength: z.number().int().min(3).max(7).default(6), barcodeLength: z.number().int().min(12).max(14).default(13),
    saleType: z.enum(['WEIGHT', 'PRICE']).default('WEIGHT'),
  }),
  scheduling: z.object({
    enabled: z.boolean().default(false), maxDaysAhead: z.number().int().min(0).max(365).default(7), leadTime: hhmm.default('00:30'),
    blockedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), blockedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    slots: z.array(slot).max(70).default([]),
  }),
  printing: z.object({
    askPrintSale: z.boolean().default(false), askPrintOrder: z.boolean().default(false), askPrintTicket: z.boolean().default(false),
    companyHeader: z.boolean().default(true), companyHeaderOnProduction: z.boolean().default(false), companyHeaderOnReports: z.boolean().default(false),
    paper: z.enum(['58mm', '80mm', 'A4']).default('58mm'), fontSize: z.number().int().min(1).max(20).default(5), promissoryPaper: z.enum(['A4', '80mm']).default('A4'), autoPrintPromissory: z.boolean().default(false),
  }),
  ticket: z.object({ enabled: z.boolean().default(true) }),
  financial: z.object({
    monthlyInterestPercent: z.number().min(0).max(100).default(0), latePenaltyPercent: z.number().min(0).max(100).default(0), graceDays: z.number().int().min(0).max(365).default(0),
    earlyDiscountPercent: z.number().min(0).max(100).default(0), earlyMinDays: z.number().int().min(0).max(365).default(0), installmentDays: z.number().int().min(1).max(365).default(30),
  }),
  products: z.object({ defaultMarginPercent: z.number().min(0).max(1000).default(0) }),
  orders: z.object({ resetCounterDaily: z.boolean().default(false) }),
  // RM Controle de Lucro: calculation method. Rates are estimates applied to registered sales; fixed categories split paid expenses into fixed and variable.
  profit: z.object({
    cardFeePercent: z.number().min(0).max(30).default(0), taxPercent: z.number().min(0).max(60).default(0),
    fixedCategories: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    includeCommissions: z.boolean().default(true),
  }),
  // RM Inteligência: which alerts the restaurant wants and their thresholds. A monthly goal of 0 means no goal.
  intelligence: z.object({
    monthlyGoal: z.number().min(0).max(100_000_000).default(0),
    alerts: z.object({
      salesDrop: z.boolean().default(true), lowStock: z.boolean().default(true), payables: z.boolean().default(true), receivables: z.boolean().default(true),
      lowMargin: z.boolean().default(true), delayedOrders: z.boolean().default(true), cashDivergence: z.boolean().default(true), waste: z.boolean().default(true),
    }).default({ salesDrop: true, lowStock: true, payables: true, receivables: true, lowMargin: true, delayedOrders: true, cashDivergence: true, waste: true }),
    salesDropPercent: z.number().int().min(5).max(90).default(30),
    payableDays: z.number().int().min(0).max(30).default(3),
    delayedMinutes: z.number().int().min(5).max(240).default(30),
    marginFloorPercent: z.number().min(0).max(100).default(15),
  }),
  // Visual identity of the restaurant (RM default: dark, gold, black sidebar). Users may override it for themselves unless allowUserOverride is off.
  appearance: z.object({
    mode: z.enum(APPEARANCE_MODES).default('DARK'), primary: z.enum(APPEARANCE_PRIMARIES).default('GOLD'), sidebar: z.enum(APPEARANCE_SIDEBARS).default('BLACK'),
    allowUserOverride: z.boolean().default(true),
  }),
  menuLayout: z.object({ hidden: z.array(z.string().max(60)).max(100).default([]) }),
  // The bot is opt-in: nothing is answered automatically until the restaurant turns it on.
  whatsapp: z.object({
    botEnabled: z.boolean().default(false), autoMessagesEnabled: z.boolean().default(true),
    greetingCooldownHours: z.number().int().min(1).max(168).default(12), handoffMinutes: z.number().int().min(5).max(1440).default(120),
    replyOutsideHours: z.boolean().default(true), aiFallback: z.boolean().default(false),
    replyDelaySeconds: z.number().int().min(0).max(10).default(2), humanizeTyping: z.boolean().default(true), menuFooter: z.string().max(200).default(''),
  }),
  orderStatuses: z.object({
    items: z.array(z.object({ key: z.string().max(40), title: z.string().min(1).max(40), active: z.boolean() })).max(30).default([]),
  }),
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;
export type TenantSettingsData = { [K in SettingsSectionName]: z.infer<typeof SETTINGS_SECTIONS[K]> };

export const DEFAULT_ORDER_STATUSES = [
  { key: 'WAITING', title: 'Aguardando', active: false }, { key: 'REVIEW', title: 'Em conferência', active: false }, { key: 'ACCEPTED', title: 'Aceito', active: true },
  { key: 'PREPARING', title: 'Em preparo', active: false }, { key: 'READY', title: 'Pronto', active: true }, { key: 'READY_PICKUP', title: 'Pronto para retirada', active: false },
  { key: 'READY_DINE_IN', title: 'Pronto para consumir', active: false }, { key: 'OUT_FOR_DELIVERY', title: 'Saiu para entrega', active: true },
  { key: 'COMPLETED', title: 'Finalizado', active: true }, { key: 'CANCELLED', title: 'Cancelado', active: true }, { key: 'REFUSED', title: 'Recusado', active: true },
];

export function parseSettings(raw: unknown): TenantSettingsData {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SETTINGS_SECTIONS)) {
    const parsed = schema.safeParse(source[name] ?? {});
    out[name] = parsed.success ? parsed.data : schema.parse({});
  }
  const statuses = out.orderStatuses as TenantSettingsData['orderStatuses'];
  if (statuses.items.length === 0) statuses.items = DEFAULT_ORDER_STATUSES.map(item => ({ ...item }));
  return out as TenantSettingsData;
}

type Reader = Pick<Prisma.TransactionClient, 'tenantSettings'>;

export async function loadSettings(client: Reader, tenantId: string): Promise<TenantSettingsData> {
  const row = await client.tenantSettings.findUnique({ where: { tenantId }, select: { settings: true } });
  return parseSettings(row?.settings);
}

// Replaces one section after validating it; unknown sections are rejected by the caller via SETTINGS_SECTIONS.
export async function saveSettingsSection<K extends SettingsSectionName>(client: Reader, tenantId: string, name: K, value: unknown): Promise<TenantSettingsData[K]> {
  const parsed = SETTINGS_SECTIONS[name].parse(value) as TenantSettingsData[K];
  const row = await client.tenantSettings.findUnique({ where: { tenantId }, select: { settings: true } });
  const current = row?.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) ? row.settings as Record<string, unknown> : {};
  const settings = { ...current, [name]: parsed } as Prisma.InputJsonValue;
  await client.tenantSettings.upsert({ where: { tenantId }, create: { tenantId, settings }, update: { settings } });
  return parsed;
}

const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

// Sequential order number shown to staff and customers; resets every day when the tenant enabled it.
export async function nextOrderNumber(tx: Prisma.TransactionClient, tenantId: string, now = new Date()): Promise<number> {
  const settings = await loadSettings(tx, tenantId);
  const row = await tx.tenantSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
  const today = startOfDay(now);
  const reset = settings.orders.resetCounterDaily && (!row.orderCounterDate || row.orderCounterDate.getTime() !== today.getTime());
  const next = reset ? 1 : row.orderCounter + 1;
  await tx.tenantSettings.update({ where: { tenantId }, data: { orderCounter: next, orderCounterDate: today } });
  return next;
}
