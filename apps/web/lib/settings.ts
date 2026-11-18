// Mirrors apps/api/src/lib/settings.ts (SETTINGS_SECTIONS). Values returned by GET /settings are always complete (defaults applied).
export type Slot = { day: number; start: string; end: string };

export type TenantSettings = {
  company: { legalName: string; tradeName: string; document: string; activity: string; slogan: string; phone: string; whatsapp: string; zip: string; state: string; city: string; district: string; address: string; number: string; dpoName: string; dpoEmail: string; sidebarLayout: 'CLASSIC' | 'COMPACT' };
  hours: { timezone: string; mode: 'OPEN' | 'CLOSED' | 'SCHEDULE'; weekly: Slot[] };
  fulfillment: { allowPickup: boolean; allowDelivery: boolean; allowDineIn: boolean; estimatedTime: boolean; pickupMinutes: number; deliveryMinutes: number; deliveryFeeMode: 'SINGLE' | 'UNMAPPED' | 'ZONES' | 'DISTRICT'; singleFee: number; minDelivery: number; freeDeliveryMin: number };
  store: { allowBuyWhenClosed: boolean; autoAccept: boolean; brandColor: string; mode: 'MENU' | 'ECOMMERCE'; minorControl: boolean; metaPixelId: string };
  pdv: { layout: 'FOOD' | 'RETAIL'; side: 'LEFT' | 'RIGHT'; orderMode: boolean; saleMode: boolean; whatsappNotify: boolean; autoRegisterCustomer: boolean; tableControl: 'TABLES' | 'TABS' | 'TABLES_AND_TABS' | 'TABLES_AND_ORDERS'; askSeller: boolean; serviceFeeName: string; defaultOrderStatus: 'OPEN' | 'PREPARING'; requireAdminPasswordOnline: boolean; showPixOnTerminal: boolean; usdRate: number; pesoRate: number };
  scale: { enabled: boolean; prefix: string; codeLength: number; barcodeLength: number; saleType: 'WEIGHT' | 'PRICE' };
  scheduling: { enabled: boolean; maxDaysAhead: number; leadTime: string; blockedFrom: string | null; blockedTo: string | null; slots: Slot[] };
  printing: { askPrintSale: boolean; askPrintOrder: boolean; askPrintTicket: boolean; companyHeader: boolean; companyHeaderOnProduction: boolean; companyHeaderOnReports: boolean; paper: '58mm' | '80mm' | 'A4'; fontSize: number; promissoryPaper: 'A4' | '80mm'; autoPrintPromissory: boolean };
  ticket: { enabled: boolean };
  financial: { monthlyInterestPercent: number; latePenaltyPercent: number; graceDays: number; earlyDiscountPercent: number; earlyMinDays: number; installmentDays: number };
  products: { defaultMarginPercent: number };
  orders: { resetCounterDaily: boolean };
  appearance: { mode: 'LIGHT' | 'DARK' | 'AUTO'; primary: 'GOLD' | 'BLUE' | 'GREEN' | 'RED' | 'YELLOW' | 'PURPLE' | 'ORANGE'; sidebar: 'BLACK' | 'WHITE' | 'GRAY' | 'GRAPHITE' | 'NAVY' | 'FOREST'; allowUserOverride: boolean };
  menuLayout: { hidden: string[] };
  whatsapp: { botEnabled: boolean; autoMessagesEnabled: boolean; greetingCooldownHours: number; handoffMinutes: number; replyOutsideHours: boolean; aiFallback: boolean; replyDelaySeconds: number; humanizeTyping: boolean; menuFooter: string };
  orderStatuses: { items: { key: string; title: string; active: boolean }[] };
};
export type SettingsSectionName = keyof TenantSettings;
export type SettingsResponse = { settings: TenantSettings; hasAdminPassword: boolean };

export const weekdayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function localClock(now: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  } catch { return { weekday: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() }; }
}
const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

export function isStoreOpen(hours: TenantSettings['hours'], now = new Date()): boolean {
  if (hours.mode === 'OPEN') return true;
  if (hours.mode === 'CLOSED') return false;
  const clock = localClock(now, hours.timezone);
  return hours.weekly.some(slot => slot.day === clock.weekday && clock.minutes >= toMinutes(slot.start) && clock.minutes <= toMinutes(slot.end));
}
