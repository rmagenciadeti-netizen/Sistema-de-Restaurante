import 'dotenv/config';
import { prisma } from './lib/prisma';
import { processWhatsappOutbox } from './lib/whatsapp-worker';
import { whatsappProviderFromEnv } from './lib/whatsapp-cloud';

// Run as a single process: `npm run worker --workspace apps/api`.
const provider = whatsappProviderFromEnv();
if (!provider) {
  console.error('WhatsApp is not configured. Set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATES; the outbox stays queued.');
  process.exit(1);
}
const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 10_000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });

async function main() {
  console.log('WhatsApp outbox worker started');
  while (!stopping) {
    try {
      const result = await processWhatsappOutbox(prisma, provider);
      if (result.sent || result.failed) console.log(`outbox: sent=${result.sent} failed=${result.failed}`);
    } catch (error) { console.error('outbox error', error); }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  await prisma.$disconnect();
}
void main();
