import { MessageStatus, PrismaClient } from '@prisma/client';

export type OutboundMessage = { id: string; tenantId: string; toPhone: string; template: string; payload: unknown };
// Implemented by a concrete official-provider adapter (e.g. WhatsApp Cloud API). None is bundled: sending requires contract, templates and credentials.
export interface WhatsappProvider {
  send(message: OutboundMessage): Promise<{ providerRef: string }>;
}

// Meant to run from a single worker process. Without a configured provider the outbox stays QUEUED; nothing is marked as sent.
export async function processWhatsappOutbox(client: PrismaClient, provider: WhatsappProvider | null, limit = 20, options: { excludeTenantIds?: string[] } = {}) {
  if (!provider) return { sent: 0, failed: 0, skipped: true as const };
  const batch = await client.whatsappMessage.findMany({ where: { status: MessageStatus.QUEUED, toPhone: { not: 'redacted' }, ...(options.excludeTenantIds?.length ? { tenantId: { notIn: options.excludeTenantIds } } : {}) }, orderBy: { createdAt: 'asc' }, take: limit });
  let sent = 0; let failed = 0;
  for (const message of batch) {
    try {
      const { providerRef } = await provider.send({ id: message.id, tenantId: message.tenantId, toPhone: message.toPhone, template: message.template, payload: message.payload });
      await client.whatsappMessage.update({ where: { id: message.id }, data: { status: MessageStatus.SENT, providerRef, sentAt: new Date() } });
      sent++;
    } catch (error) {
      failed++;
      await client.whatsappMessage.update({ where: { id: message.id }, data: { status: MessageStatus.FAILED, error: (error instanceof Error ? error.message : 'SEND_FAILED').slice(0, 500) } });
    }
  }
  return { sent, failed, skipped: false as const };
}
