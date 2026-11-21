import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerMonitor, describeError, evaluateWorkerHealth, type MonitorConfig } from './worker-health';

const t0 = new Date('2026-11-21T12:00:00.000Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const config: MonitorConfig = { instance: 'srv-1:10', commit: 'abc1234', beatMs: 10_000, intervalMs: 10_000, automationsEveryMs: 900_000, outboxEnabled: false, sessionsMode: 'auto' };
const rowFrom = (monitor: WorkerMonitor, heartbeatAt: Date, stoppedAt: Date | null = null) => ({ commit: monitor.commit, startedAt: monitor.startedAt, heartbeatAt, stoppedAt, details: JSON.parse(JSON.stringify(monitor.details())) });

test('no heartbeat ever recorded: the worker is reported as absent', () => {
  const health = evaluateWorkerHealth(null, t0);
  assert.equal(health.status, 'absent'); assert.equal(health.tasks, null); assert.equal(health.heartbeatAgeSeconds, null);
});

test('a fresh heartbeat with every task succeeding is up and exposes progress counters', () => {
  const monitor = new WorkerMonitor(config, t0);
  monitor.cycles = 12; monitor.success('scheduling', 2, at(100)); monitor.success('automations', 3, at(100));
  const health = evaluateWorkerHealth(rowFrom(monitor, at(105)), at(110));
  assert.equal(health.status, 'up', health.reason ?? '');
  assert.equal(health.heartbeatAgeSeconds, 5); assert.equal(health.uptimeSeconds, 105); assert.equal(health.commit, 'abc1234');
  assert.deepEqual(health.tasks?.scheduling, { status: 'ok', runs: 1, processed: 2, failures: 0, lastSuccessAgeSeconds: 10 });
  assert.equal(health.tasks?.automations.processed, 3);
  assert.equal(health.tasks?.outbox.status, 'disabled', 'a channel that is not configured is not a problem');
  assert.deepEqual(health.whatsappSessions, { mode: 'auto', leader: false });
});

test('a stale heartbeat means down, and so does a worker that announced it stopped', () => {
  const monitor = new WorkerMonitor(config, t0);
  monitor.success('scheduling', 0, at(10));
  assert.equal(evaluateWorkerHealth(rowFrom(monitor, at(10)), at(40)).status, 'up', '30 s without a beat is still tolerated');
  const stale = evaluateWorkerHealth(rowFrom(monitor, at(10)), at(120));
  assert.equal(stale.status, 'down'); assert.match(stale.reason ?? '', /stale/);
  const stopped = evaluateWorkerHealth(rowFrom(monitor, at(20), at(20)), at(21));
  assert.equal(stopped.status, 'down'); assert.match(stopped.reason ?? '', /stopped/);
  const restarted = evaluateWorkerHealth(rowFrom(monitor, at(30), at(20)), at(31));
  assert.equal(restarted.status, 'up', 'a newer heartbeat after the stop (new instance) means running again');
});

test('alive but not processing is degraded: a failing task or one that stopped succeeding', () => {
  const failing = new WorkerMonitor(config, t0);
  failing.success('scheduling', 0, at(10)); failing.success('automations', 0, at(10));
  failing.failure('scheduling', Object.assign(new Error('\nInvalid `prisma.order.findMany()` invocation:\n\n\nCan\'t reach database server at `ep-secret-host.neon.tech:5432`'), { code: 'P1001' }), at(20));
  const view = evaluateWorkerHealth(rowFrom(failing, at(21)), at(22));
  assert.equal(view.status, 'degraded'); assert.equal(view.tasks?.scheduling.status, 'error'); assert.equal(view.tasks?.scheduling.failures, 1);
  assert.equal(JSON.stringify(view).includes('ep-secret-host'), false, 'error text (which may name hosts) never reaches the public view');

  const stalled = new WorkerMonitor(config, t0);
  stalled.success('scheduling', 0, at(10)); stalled.success('automations', 0, at(10));
  const late = evaluateWorkerHealth(rowFrom(stalled, at(400)), at(401));
  assert.equal(late.status, 'degraded'); assert.equal(late.tasks?.scheduling.status, 'stale'); assert.equal(late.tasks?.automations.status, 'ok', 'automations run every 15 min, so 6 min is fine');

  stalled.success('scheduling', 0, at(400));
  assert.equal(evaluateWorkerHealth(rowFrom(stalled, at(401)), at(402)).status, 'up', 'recovers as soon as the task succeeds again');
});

test('a task that has not run yet is pending during start-up and stale afterwards', () => {
  const monitor = new WorkerMonitor(config, t0);
  const booting = evaluateWorkerHealth(rowFrom(monitor, at(5)), at(6));
  assert.equal(booting.status, 'up'); assert.equal(booting.tasks?.scheduling.status, 'pending');
  const neverRan = evaluateWorkerHealth(rowFrom(monitor, at(600)), at(601));
  assert.equal(neverRan.status, 'degraded'); assert.equal(neverRan.tasks?.scheduling.status, 'stale');
});

test('a heartbeat row without usable details is degraded, never trusted', () => {
  const row = { commit: null, startedAt: t0, heartbeatAt: at(5), stoppedAt: null };
  for (const details of [null, 'oops', { tasks: 1 }, { tasks: { scheduling: {} } }]) assert.equal(evaluateWorkerHealth({ ...row, details }, at(6)).status, 'degraded');
});

test('the monitor counts runs, reports recoveries and keeps the last error only while failing', () => {
  const monitor = new WorkerMonitor({ ...config, outboxEnabled: true }, t0);
  assert.equal(monitor.failure('outbox', new Error('boom')), 1); assert.equal(monitor.failure('outbox', new Error('boom')), 2);
  assert.equal(monitor.details().tasks.outbox.lastError, 'boom');
  assert.equal(monitor.success('outbox', 4), 2, 'returns the failures in a row that just ended');
  const outbox = monitor.details().tasks.outbox;
  assert.deepEqual({ runs: outbox.runs, processed: outbox.processed, failures: outbox.failures, lastError: outbox.lastError, enabled: outbox.enabled }, { runs: 3, processed: 4, failures: 2, lastError: null, enabled: true });
  assert.match(monitor.summary(at(61)), /uptime=61s .*outbox\[runs=3 processed=4 failures=2\]/);
});

test('describeError keeps the code and the first useful line, and stays short', () => {
  const header = '\nInvalid `prisma.x.findMany()` invocation:\n\n\n';
  assert.equal(describeError(Object.assign(new Error(`${header}Can't reach database server at \`host:5432\`\n\nPlease make sure your database server is running.`), { code: 'P1001' })), "P1001: Can't reach database server at `host:5432`");
  assert.equal(describeError(Object.assign(new Error('Authentication failed against database server\n\nPlease make sure to provide valid credentials.'), { errorCode: 'P1000' })), 'P1000: Authentication failed against database server', 'initialization errors carry errorCode');
  assert.equal(describeError('plain'), 'plain');
  assert.ok(describeError(new Error('x'.repeat(1000))).length <= 300);
});
