import { Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { autoMessageDef, renderTemplate } from './whatsapp-messages';
import { formatLocal } from './whatsapp-text';

type Db = PrismaClient | Prisma.TransactionClient;

export const last8 = (phone: string) => phone.replace(/\D/g, '').slice(-8);
// Customer phones are stored without a guaranteed country code; WhatsApp needs one (Brazil by default).
export const toWhatsappDigits = (phone: string) => { const digits = phone.replace(/\D/g, ''); return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits; };

export async function isOptedOut(db: Db, tenantId: string, phone: string): Promise<boolean> {
  if (last8(phone).length < 8) return false;
  return Boolean(await db.whatsappConversation.findFirst({ where: { tenantId, optOut: true, phone: { endsWith: last8(phone) } }, select: { id: true } }));
}

export type AutoMessageContext = { restaurant: string; vars: Record<string, string | number | null | undefined> };

// Queues an automatic message when the tenant keeps automatic messages on, the specific template is enabled and the customer did not opt out.
// Sending happens in the session manager (QR) or the Cloud worker; nothing is marked as sent here.
export async function enqueueAutoMessage(db: Db, args: { tenantId: string; key: string; phone: string | null | undefined; orderId?: string | null; vars: Record<string, string | number | null | undefined> }): Promise<boolean> {
  const def = autoMessageDef(args.key);
  if (!def || !args.phone || args.phone.replace(/\D/g, '').length < 8) return false;
  const [settings, override, tenant] = await Promise.all([
    loadSettings(db, args.tenantId),
    db.whatsappAutoMessage.findUnique({ where: { tenantId_key: { tenantId: args.tenantId, key: args.key } } }),
    db.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }),
  ]);
  if (!settings.whatsapp.autoMessagesEnabled) return false;
  if (!(override ? override.enabled : def.defaultEnabled)) return false;
  if (await isOptedOut(db, args.tenantId, args.phone)) return false;
  const restaurant = settings.company.tradeName || tenant?.name || '';
  await db.whatsappMessage.create({ data: { tenantId: args.tenantId, orderId: args.orderId ?? null, toPhone: args.phone, template: args.key, payload: { restaurante: restaurant, ...args.vars } as Prisma.InputJsonObject } });
  return true;
}

export const orderLabel = (order: { number?: number | null; code: string }) => (order.number ? `#${order.number}` : order.code);
export const brl = (value: Prisma.Decimal | number | string) => `R$ ${Number(value).toFixed(2).replace('.', ',')}`;

export function scheduledSuffix(scheduledFor: Date | null | undefined, timeZone: string) {
  return scheduledFor ? ` Agendado para ${formatLocal(scheduledFor, timeZone)}.` : '';
}

export function renderStored(body: string, payload: unknown) {
  const values = payload && typeof payload === 'object' ? payload as Record<string, string | number> : {};
  return renderTemplate(body, values);
}
