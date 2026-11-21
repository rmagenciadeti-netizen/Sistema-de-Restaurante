import './lib/env';
import os from 'node:os';
import { prisma } from './lib/prisma';
import { assertWorkerEnv } from './lib/env-check';
import { emailProviders } from './lib/providers';
import { smtpEmailProviderFromEnv } from './lib/smtp-email';
import { whatsappProviderFromEnv } from './lib/whatsapp-cloud';
import { WhatsappSessionManager, runsInWorker, whatsappSessionsMode } from './lib/whatsapp-sessions';
import { startAiConfigRefresh } from './lib/ai-provider';
import { createWorkerRuntime } from './lib/worker-runtime';
import { WorkerMonitor, describeError } from './lib/worker-health';

// Run as a single process: `npm run start:worker --workspace apps/api` (compiled) or `npm run worker --workspace apps/api` (tsx).
// Every cycle it releases scheduled orders that are due; every AUTOMATIONS_INTERVAL_MS it runs the automations of each active restaurant; it sends the
// WhatsApp Cloud API outbox when that channel is configured, and keeps the WhatsApp Web (QR) sessions alive (leader election in the database, shared with the API).
// Everything it does is counted by a WorkerMonitor and saved as a heartbeat (lib/worker-health.ts), served at GET /api/v1/health/worker.
// The same loops can run inside the API process when the host has no separate worker (lib/worker-runtime.ts, "embedded" mode); a running dedicated worker always wins.
const log = (message: string) => console.log(`[worker] ${message}`);
const monitorRef: { current: WorkerMonitor | null } = { current: null };
let stopping = false;
const wake = new AbortController();
const sleep = (ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  wake.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function stop(signal: string) {
  if (stopping) return;
  stopping = true; wake.abort();
  log(`${signal} received: finishing the current work and stopping`);
  // The host kills the process after its own grace period; leave first, cleanly.
  setTimeout(() => { console.error('[worker] shutdown took too long: forcing exit'); process.exit(1); }, 25_000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal));
// WhatsApp sockets and database hiccups can reject promises nobody awaits. That must not take the whole worker (and every task) down.
process.on('unhandledRejection', reason => {
  if (monitorRef.current) monitorRef.current.unhandledRejections += 1;
  console.error('[worker] unhandled rejection (the worker keeps running):', reason);
});
process.on('uncaughtException', error => { console.error('[worker] uncaught exception:', error); process.exit(1); });

// Neon may need a moment to wake up; a wrong URL or password must fail loudly instead of leaving a "Live" worker that cannot reach anything.
async function connectDatabase(attempts = 6) {
  for (let attempt = 1; !stopping; attempt += 1) {
    try { await prisma.$queryRaw`SELECT 1`; log(`database connection OK (attempt ${attempt})`); return; }
    catch (error) {
      console.error(`[worker] database not reachable (attempt ${attempt}/${attempts}): ${describeError(error)}`);
      if (attempt >= attempts) throw new Error('DATABASE_UNREACHABLE');
      await sleep(Math.min(15_000, 1000 * 2 ** (attempt - 1)));
    }
  }
}

async function main() {
  assertWorkerEnv();
  const intervalMs = Math.max(100, Number(process.env.WORKER_INTERVAL_MS) || 10_000);
  const automationsEveryMs = Number(process.env.AUTOMATIONS_INTERVAL_MS) || 15 * 60_000;
  const summaryEveryMs = Number(process.env.WORKER_LOG_EVERY_MS) || 5 * 60_000;
  const beatMs = Math.min(intervalMs, 10_000);
  const cloud = whatsappProviderFromEnv();
  const sessionsMode = whatsappSessionsMode();
  try { const smtp = smtpEmailProviderFromEnv(); if (smtp) emailProviders.register(smtp); }
  catch (error) { console.error(`[worker] SMTP is misconfigured; automation e-mails are disabled: ${describeError(error)}`); }
  const monitor = monitorRef.current = new WorkerMonitor({ instance: `${process.env.RENDER_INSTANCE_ID ?? os.hostname()}:${process.pid}`, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null, beatMs, intervalMs, automationsEveryMs, outboxEnabled: Boolean(cloud), sessionsMode });

  console.log('Worker started');
  log(`instance=${monitor.instance} commit=${monitor.commit ?? 'n/a'} node=${process.version} interval=${intervalMs}ms automations=${automationsEveryMs}ms whatsappSessions=${sessionsMode} cloudApi=${cloud ? 'on' : 'off'} email=${emailProviders.get('smtp') ? 'smtp' : 'off'}`);
  if (!cloud) log('WhatsApp Cloud API is not configured (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATES); only QR sessions can send.');
  await connectDatabase();
  if (stopping) return;

  const manager = runsInWorker(sessionsMode) ? new WhatsappSessionManager(prisma) : null;
  const stopAiRefresh = startAiConfigRefresh(prisma);
  const runtime = createWorkerRuntime({ prisma, monitor, manager, cloud, intervalMs, automationsEveryMs, summaryEveryMs, beatMs, log });
  await runtime.start();
  void manager?.start().catch(error => console.error(`[worker] WhatsApp session manager not started: ${describeError(error)}`));

  while (!stopping) await sleep(60_000);

  stopAiRefresh();
  await runtime.stop();
  await manager?.stop().catch(error => console.error(`[worker] WhatsApp session manager did not stop cleanly: ${describeError(error)}`));
  await prisma.$disconnect();
  log(`stopped. ${monitor.summary()}`);
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
