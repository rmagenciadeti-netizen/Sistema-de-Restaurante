import os from 'node:os';
import type { PrismaClient } from '@prisma/client';
import { runAutomationsForAllTenants } from './automations';
import { releaseDueOrders } from './scheduling';
import { whatsappProviderFromEnv } from './whatsapp-cloud';
import { whatsappSessionsMode } from './whatsapp-sessions';
import { processWhatsappOutbox } from './whatsapp-worker';
import { claimWorkerRow, describeError, WorkerMonitor, writeHeartbeat, writeStopped, type TaskName } from './worker-health';

// The work of the "worker" — release scheduled orders, run the automations, send the WhatsApp Cloud outbox, and say so in a heartbeat — as a runtime that can live in
// its own service (apps/api/src/worker.ts) or, when the host has no separate worker (a free plan), inside the API process ("embedded"). Both modes record the same
// proof in the same heartbeat row, served at GET /api/v1/health/worker.
export type WorkerRuntimeOptions = {
  prisma: PrismaClient; monitor: WorkerMonitor; manager: { isLeader(): boolean } | null; cloud: ReturnType<typeof whatsappProviderFromEnv>;
  intervalMs: number; automationsEveryMs: number; summaryEveryMs: number; beatMs: number; log: (message: string) => void;
  // Embedded runtimes only work while nobody else has a fresh heartbeat; a heartbeat older than this means its owner is gone.
  staleMs?: number;
};

export function createWorkerRuntime(options: WorkerRuntimeOptions) {
  const { prisma, monitor, manager, cloud, intervalMs, automationsEveryMs, summaryEveryMs, beatMs, log } = options;
  const embedded = monitor.embedded;
  const staleMs = options.staleMs ?? Math.max(45_000, 4 * beatMs);
  let stopping = false; let leading = !embedded; let beating = false; let beatFailures = 0;
  let lastAutomations = 0; let lastSummary = Date.now(); let automationsPass: Promise<void> = Promise.resolve(); let automationsRunning = false;
  const wake = new AbortController();
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    wake.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  // Independent of the task loop, so a long task never makes a healthy worker look dead. Failing to save it never stops the work itself.
  const beat = async () => {
    if (beating) return;
    beating = true; monitor.whatsapp.leader = manager?.isLeader() ?? false;
    try {
      if (embedded) {
        const owned = await claimWorkerRow(prisma, monitor.instance, staleMs);
        if (owned !== leading) log(owned ? 'this process now runs the worker tasks' : 'another worker is running: standing by');
        leading = owned; monitor.standby = !owned;
        if (!owned) return;
      }
      await writeHeartbeat(prisma, monitor);
      if (beatFailures > 0) log(`heartbeat saved again after ${beatFailures} failure(s)`);
      beatFailures = 0;
    } catch (error) {
      monitor.heartbeatFailures += 1; beatFailures += 1;
      if (beatFailures === 1 || beatFailures % 30 === 0) console.error(`[worker] heartbeat could not be saved (is the latest database migration applied?): ${describeError(error)}`);
    } finally { beating = false; }
  };

  // A failing task is recorded and retried next cycle; one task never blocks the others. Repeated identical failures are logged sparingly.
  const task = async (name: TaskName, run: () => Promise<number>) => {
    try {
      const recovered = monitor.success(name, await run());
      if (recovered > 0) log(`${name} recovered after ${recovered} failed run(s)`);
    } catch (error) {
      const streak = monitor.failure(name, error);
      if (streak === 1 || streak % 30 === 0) console.error(`[worker] ${name} error (${streak} in a row):`, error);
    }
  };

  const cycle = async () => {
    if (!leading) return;
    monitor.cycles += 1;
    await task('scheduling', async () => {
      const released = await releaseDueOrders(prisma);
      if (released) log(`scheduled orders released=${released}`);
      return released;
    });
    // Runs beside the loop: with many restaurants the pass takes a while and must not delay the release of scheduled orders.
    if (!automationsRunning && Date.now() - lastAutomations >= automationsEveryMs) {
      lastAutomations = Date.now(); automationsRunning = true;
      automationsPass = task('automations', async () => {
        const created = await runAutomationsForAllTenants(prisma);
        if (created) log(`automation notifications created=${created}`);
        return created;
      }).finally(() => { automationsRunning = false; });
    }
    if (cloud) {
      await task('outbox', async () => {
        const qrTenants = (await prisma.whatsappSession.findMany({ where: { desired: 'CONNECTED' }, select: { tenantId: true } })).map(row => row.tenantId);
        const result = await processWhatsappOutbox(prisma, cloud, 20, { excludeTenantIds: qrTenants });
        if (result.sent || result.failed) log(`outbox: sent=${result.sent} failed=${result.failed}`);
        return result.sent + result.failed;
      });
    }
    if (Date.now() - lastSummary >= summaryEveryMs) { lastSummary = Date.now(); log(monitor.summary()); }
  };

  let beatTimer: NodeJS.Timeout | null = null;
  let loopDone: Promise<void> = Promise.resolve();
  return {
    monitor, beat, cycle, isLeading: () => leading,
    async start() {
      await beat();
      beatTimer = setInterval(() => void beat(), beatMs); beatTimer.unref();
      loopDone = (async () => { while (!stopping) { await cycle(); await sleep(intervalMs); } })();
    },
    async stop() {
      stopping = true; wake.abort();
      if (beatTimer) clearInterval(beatTimer);
      await loopDone;
      await Promise.race([automationsPass, new Promise(resolve => setTimeout(resolve, 8_000))]);
      // Only the instance that owns the row may mark it stopped: during a deploy the old instance exits after the new one already took over.
      if (leading) await writeStopped(prisma, monitor).catch(() => undefined);
    },
  };
}

// EMBEDDED_WORKER: "on"/"off", or "auto" (default) = on in production. A restaurant whose host has no separate worker service (a free plan) still gets scheduled orders,
// automations and the heartbeat, from the API process itself; the moment a dedicated worker has a fresh heartbeat this one stands by, so nothing runs twice.
export function embeddedWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.EMBEDDED_WORKER ?? 'auto').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  return value === 'auto' && env.NODE_ENV === 'production';
}

export function startEmbeddedWorker(prisma: PrismaClient, manager: { isLeader(): boolean } | null, env: NodeJS.ProcessEnv = process.env) {
  const intervalMs = Math.max(100, Number(env.WORKER_INTERVAL_MS) || 10_000);
  const automationsEveryMs = Number(env.AUTOMATIONS_INTERVAL_MS) || 15 * 60_000;
  const beatMs = Math.min(intervalMs, 10_000);
  const cloud = whatsappProviderFromEnv();
  const monitor = new WorkerMonitor({ instance: `${env.RENDER_INSTANCE_ID ?? os.hostname()}:${process.pid}:api`, commit: env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null, beatMs, intervalMs, automationsEveryMs, outboxEnabled: Boolean(cloud), sessionsMode: whatsappSessionsMode(env), embedded: true });
  const log = (message: string) => console.log(`[worker:embedded] ${message}`);
  const runtime = createWorkerRuntime({ prisma, monitor, manager, cloud, intervalMs, automationsEveryMs, summaryEveryMs: Number(env.WORKER_LOG_EVERY_MS) || 5 * 60_000, beatMs, log });
  log(`starting inside the API process (instance=${monitor.instance} interval=${intervalMs}ms cloudApi=${cloud ? 'on' : 'off'})`);
  void runtime.start().catch(error => console.error(`[worker:embedded] could not start: ${describeError(error)}`));
  // A free Render web service sleeps after 15 minutes without incoming requests, which would also put the WhatsApp session and every task to sleep.
  // Calling its own public URL (it is awake right now) counts as incoming traffic. Needs RENDER_EXTERNAL_URL (set by Render); KEEP_ALIVE=off disables it.
  const url = env.RENDER_EXTERNAL_URL?.replace(/\/$/, '');
  if (url && env.KEEP_ALIVE !== 'off') {
    const ping = () => fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(20_000) }).catch(error => console.warn(`[worker:embedded] keep-alive ping failed: ${describeError(error)}`));
    setInterval(() => void ping(), 8 * 60_000).unref();
  }
  return runtime;
}
