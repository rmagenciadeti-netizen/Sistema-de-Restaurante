import type { Prisma, PrismaClient, WorkerHeartbeat } from '@prisma/client';

// "Live" on the host only says the worker process exists. The worker records what it actually does (per-task runs, items processed, failures) in the
// WorkerHeartbeat row and the API serves a sanitized view at GET /api/v1/health/worker, so a worker that is up but not processing is visible.
export const WORKER_ROW_ID = 'main';
export type TaskName = 'scheduling' | 'automations' | 'outbox';
export type TaskReport = { enabled: boolean; everyMs: number; runs: number; processed: number; failures: number; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null };
export type WorkerDetails = { beatMs: number; tasks: Record<TaskName, TaskReport>; whatsapp: { mode: string; leader: boolean }; unhandledRejections: number; heartbeatFailures: number; embedded: boolean };
export type MonitorConfig = { instance: string; commit: string | null; beatMs: number; intervalMs: number; automationsEveryMs: number; outboxEnabled: boolean; sessionsMode: string; embedded?: boolean };

const TASKS: TaskName[] = ['scheduling', 'automations', 'outbox'];

// One-line description for logs and stored errors: the Prisma/network message without its multi-line invocation dump. Never includes connection strings.
export function describeError(error: unknown): string {
  const raw = typeof error === 'object' && error !== null ? (error as { code?: unknown; errorCode?: unknown }) : {};
  const code = raw.code ?? raw.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n').map(line => line.trim()).filter(line => line && !/invocation:$/.test(line))[0] ?? 'unknown error';
  return `${code != null ? `${String(code)}: ` : ''}${firstLine}`.slice(0, 300);
}

// Collected in memory by the worker process and flushed to the database by the heartbeat timer.
export class WorkerMonitor {
  readonly startedAt: Date;
  readonly instance: string;
  readonly commit: string | null;
  // Embedded: the loops run inside the API process (no separate worker service). Standby: another instance owns the work right now.
  readonly embedded: boolean;
  standby = false;
  cycles = 0;
  unhandledRejections = 0;
  heartbeatFailures = 0;
  whatsapp: { mode: string; leader: boolean };
  private readonly beatMs: number;
  private readonly tasks: Record<TaskName, TaskReport>;
  private readonly streak: Record<TaskName, number> = { scheduling: 0, automations: 0, outbox: 0 };

  constructor(config: MonitorConfig, now = new Date()) {
    this.startedAt = now; this.instance = config.instance; this.commit = config.commit; this.beatMs = config.beatMs; this.embedded = config.embedded === true;
    this.whatsapp = { mode: config.sessionsMode, leader: false };
    const task = (enabled: boolean, everyMs: number): TaskReport => ({ enabled, everyMs, runs: 0, processed: 0, failures: 0, lastRunAt: null, lastSuccessAt: null, lastError: null });
    this.tasks = { scheduling: task(true, config.intervalMs), automations: task(true, config.automationsEveryMs), outbox: task(config.outboxEnabled, config.intervalMs) };
  }

  // Returns how many failures in a row the task had before this success (0 = it was healthy), so the caller can log the recovery.
  success(name: TaskName, processed: number, now = new Date()): number {
    const task = this.tasks[name]; const previous = this.streak[name];
    task.runs += 1; task.processed += processed; task.lastRunAt = task.lastSuccessAt = now.toISOString(); task.lastError = null; this.streak[name] = 0;
    return previous;
  }

  // Returns the number of failures in a row, so the caller can avoid flooding the log while a dependency (e.g. the database) is down.
  failure(name: TaskName, error: unknown, now = new Date()): number {
    const task = this.tasks[name];
    task.runs += 1; task.failures += 1; task.lastRunAt = now.toISOString(); task.lastError = describeError(error); this.streak[name] += 1;
    return this.streak[name];
  }

  details(): WorkerDetails {
    return { beatMs: this.beatMs, tasks: structuredClone(this.tasks), whatsapp: { ...this.whatsapp }, unhandledRejections: this.unhandledRejections, heartbeatFailures: this.heartbeatFailures, embedded: this.embedded };
  }

  summary(now = new Date()): string {
    const line = (name: TaskName) => { const task = this.tasks[name]; return task.enabled ? `${name}[runs=${task.runs} processed=${task.processed} failures=${task.failures}]` : `${name}[off]`; };
    return `heartbeat uptime=${Math.round((now.getTime() - this.startedAt.getTime()) / 1000)}s mode=${this.embedded ? 'embedded' : 'dedicated'} cycles=${this.cycles} ${TASKS.map(line).join(' ')} whatsapp[mode=${this.whatsapp.mode} leader=${this.whatsapp.leader}] unhandledRejections=${this.unhandledRejections}`;
  }
}

const asJson = (details: WorkerDetails) => details as unknown as Prisma.InputJsonValue;

export async function writeHeartbeat(db: Pick<PrismaClient, 'workerHeartbeat'>, monitor: WorkerMonitor, now = new Date()) {
  const data = { instance: monitor.instance, commit: monitor.commit, startedAt: monitor.startedAt, heartbeatAt: now, stoppedAt: null, details: asJson(monitor.details()) };
  await db.workerHeartbeat.upsert({ where: { id: WORKER_ROW_ID }, create: { id: WORKER_ROW_ID, ...data }, update: data });
}

// Embedded workers (running inside the API) never push a dedicated worker aside: they own the work only while nobody else has a fresh heartbeat, and give it back as
// soon as one appears. Returns true when this instance owns the row (it already did, or the owner stopped / went stale / never existed).
export async function claimWorkerRow(db: Pick<PrismaClient, 'workerHeartbeat'>, instance: string, staleMs: number, now = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - staleMs);
  const taken = await db.workerHeartbeat.updateMany({ where: { id: WORKER_ROW_ID, OR: [{ instance }, { heartbeatAt: { lt: stale } }, { stoppedAt: { not: null } }] }, data: { instance } });
  if (taken.count === 1) return true;
  if (await db.workerHeartbeat.findUnique({ where: { id: WORKER_ROW_ID }, select: { id: true } })) return false;
  try { await db.workerHeartbeat.create({ data: { id: WORKER_ROW_ID, instance, startedAt: now, heartbeatAt: now } }); return true; } catch { return false; }
}

// Only the instance that owns the row may mark it stopped: during a deploy the old instance exits after the new one already took over.
export async function writeStopped(db: Pick<PrismaClient, 'workerHeartbeat'>, monitor: WorkerMonitor, now = new Date()) {
  await db.workerHeartbeat.updateMany({ where: { id: WORKER_ROW_ID, instance: monitor.instance }, data: { heartbeatAt: now, stoppedAt: now, details: asJson(monitor.details()) } });
}

export type TaskStatus = 'ok' | 'pending' | 'error' | 'stale' | 'disabled';
export type WorkerStatus = 'up' | 'degraded' | 'down' | 'absent';
export type WorkerHealth = {
  status: WorkerStatus; reason: string | null; service: 'rm-restaurant-worker'; checkedAt: string;
  // "dedicated": its own service; "embedded": the loops run inside the API process (same tasks, same proof).
  mode: 'dedicated' | 'embedded' | null;
  heartbeatAgeSeconds: number | null; startedAt: string | null; uptimeSeconds: number | null; commit: string | null;
  tasks: Record<TaskName, { status: TaskStatus; runs: number; processed: number; failures: number; lastSuccessAgeSeconds: number | null }> | null;
  whatsappSessions: { mode: string; leader: boolean } | null;
};

const MIN_STALE_MS = 45_000;
const STALE_BEATS = 4;
const MIN_TASK_LIMIT_MS = 120_000;
const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

// The row comes from the database: never trust its shape.
function parseDetails(value: unknown): WorkerDetails | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WorkerDetails>;
  if (!raw.tasks || typeof raw.tasks !== 'object') return null;
  const tasks = {} as Record<TaskName, TaskReport>;
  for (const name of TASKS) {
    const task = raw.tasks[name];
    if (!task || typeof task !== 'object') return null;
    tasks[name] = { enabled: task.enabled === true, everyMs: Number(task.everyMs) || 10_000, runs: Number(task.runs) || 0, processed: Number(task.processed) || 0, failures: Number(task.failures) || 0, lastRunAt: typeof task.lastRunAt === 'string' ? task.lastRunAt : null, lastSuccessAt: typeof task.lastSuccessAt === 'string' ? task.lastSuccessAt : null, lastError: typeof task.lastError === 'string' ? task.lastError : null };
  }
  return { beatMs: Number(raw.beatMs) || 10_000, tasks, whatsapp: { mode: String(raw.whatsapp?.mode ?? 'unknown'), leader: raw.whatsapp?.leader === true }, unhandledRejections: Number(raw.unhandledRejections) || 0, heartbeatFailures: Number(raw.heartbeatFailures) || 0, embedded: raw.embedded === true };
}

function taskStatus(task: TaskReport, nowMs: number, uptimeMs: number): TaskStatus {
  if (!task.enabled) return 'disabled';
  if (task.lastError) return 'error';
  const limit = Math.max(MIN_TASK_LIMIT_MS, 3 * task.everyMs);
  const lastOk = task.lastSuccessAt ? Date.parse(task.lastSuccessAt) : null;
  if (lastOk === null || Number.isNaN(lastOk)) return uptimeMs > limit ? 'stale' : 'pending';
  return nowMs - lastOk > limit ? 'stale' : 'ok';
}

// Public, sanitized view: statuses, ages and counters only. Error messages (which can name hosts) stay in the database and in the worker logs.
export function evaluateWorkerHealth(row: Pick<WorkerHeartbeat, 'commit' | 'startedAt' | 'heartbeatAt' | 'stoppedAt' | 'details'> | null, now = new Date()): WorkerHealth {
  const base = { service: 'rm-restaurant-worker' as const, checkedAt: now.toISOString() };
  if (!row) return { ...base, status: 'absent', reason: 'the worker has never reported a heartbeat', mode: null, heartbeatAgeSeconds: null, startedAt: null, uptimeSeconds: null, commit: null, tasks: null, whatsappSessions: null };
  const nowMs = now.getTime();
  const details = parseDetails(row.details);
  const age = Math.max(0, nowMs - row.heartbeatAt.getTime());
  const uptimeMs = Math.max(0, row.heartbeatAt.getTime() - row.startedAt.getTime());
  const tasks = details ? Object.fromEntries(TASKS.map(name => {
    const task = details.tasks[name];
    return [name, { status: taskStatus(task, nowMs, uptimeMs), runs: task.runs, processed: task.processed, failures: task.failures, lastSuccessAgeSeconds: task.lastSuccessAt ? seconds(nowMs - Date.parse(task.lastSuccessAt)) : null }];
  })) as NonNullable<WorkerHealth['tasks']> : null;

  let status: WorkerStatus = 'up'; let reason: string | null = null;
  if (row.stoppedAt && row.stoppedAt.getTime() >= row.heartbeatAt.getTime()) { status = 'down'; reason = 'the worker was stopped'; }
  else if (age > Math.max(MIN_STALE_MS, STALE_BEATS * (details?.beatMs ?? 10_000))) { status = 'down'; reason = 'the worker heartbeat is stale'; }
  else if (!tasks) { status = 'degraded'; reason = 'the worker reported no task details'; }
  else {
    const failing = TASKS.find(name => tasks[name].status === 'error' || tasks[name].status === 'stale');
    if (failing) { status = 'degraded'; reason = `task "${failing}" is ${tasks[failing].status}`; }
  }
  return { ...base, status, reason, mode: details?.embedded ? 'embedded' : 'dedicated', heartbeatAgeSeconds: seconds(age), startedAt: row.startedAt.toISOString(), uptimeSeconds: seconds(uptimeMs), commit: row.commit, tasks, whatsappSessions: details ? { mode: details.whatsapp.mode, leader: details.whatsapp.leader } : null };
}

export async function readWorkerHealth(db: Pick<PrismaClient, 'workerHeartbeat'>, now = new Date()): Promise<WorkerHealth> {
  return evaluateWorkerHealth(await db.workerHeartbeat.findUnique({ where: { id: WORKER_ROW_ID } }), now);
}
