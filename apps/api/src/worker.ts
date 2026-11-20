import './lib/env';
import { prisma } from './lib/prisma';
import { processWhatsappOutbox } from './lib/whatsapp-worker';
import { whatsappProviderFromEnv } from './lib/whatsapp-cloud';
import { releaseDueOrders } from './lib/scheduling';
import { WhatsappSessionManager, runsInWorker } from './lib/whatsapp-sessions';
import { runAutomationsForAllTenants } from './lib/automations';
import { startAiConfigRefresh } from './lib/ai-provider';

// Run as a single process: `npm run worker --workspace apps/api`.
// It releases scheduled orders, keeps the WhatsApp Web (QR) sessions alive (unless WHATSAPP_SESSIONS_MODE=api/off) and
// sends the Cloud API outbox for tenants without a QR session. Without any WhatsApp channel the outbox stays queued.
const provider = whatsappProviderFromEnv();
if (!provider) console.error('WhatsApp Cloud API is not configured (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATES); only QR sessions can send.');
const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 10_000;
const manager = runsInWorker() ? new WhatsappSessionManager(prisma) : null;
let stopping = false;
const automationsEveryMs = Number(process.env.AUTOMATIONS_INTERVAL_MS) || 15 * 60_000;
let lastAutomations = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });

async function main() {
  console.log('Worker started');
  startAiConfigRefresh(prisma);
  await manager?.start();
  while (!stopping) {
    try {
      const released = await releaseDueOrders(prisma);
      if (released) console.log(`scheduled orders released=${released}`);
    } catch (error) { console.error('scheduling error', error); }
    if (Date.now() - lastAutomations >= automationsEveryMs) {
      lastAutomations = Date.now();
      try {
        const created = await runAutomationsForAllTenants(prisma);
        if (created) console.log(`automation notifications created=${created}`);
      } catch (error) { console.error('automations error', error); }
    }
    if (provider) {
      try {
        const qrTenants = (await prisma.whatsappSession.findMany({ where: { desired: 'CONNECTED' }, select: { tenantId: true } })).map(row => row.tenantId);
        const result = await processWhatsappOutbox(prisma, provider, 20, { excludeTenantIds: qrTenants });
        if (result.sent || result.failed) console.log(`outbox: sent=${result.sent} failed=${result.failed}`);
      } catch (error) { console.error('outbox error', error); }
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  await manager?.stop();
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exit(1); });
