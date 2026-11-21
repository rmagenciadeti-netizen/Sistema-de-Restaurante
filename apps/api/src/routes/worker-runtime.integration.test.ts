import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { createWorkerRuntime, embeddedWorkerEnabled } from '../lib/worker-runtime';
import { readWorkerHealth, WORKER_ROW_ID, WorkerMonitor } from '../lib/worker-health';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). The runtime is the real one; the work it does (releasing a scheduled order) is real database work.
const enabled = process.env.RUN_DB_TESTS === '1';
const sfx = () => randomBytes(4).toString('hex');

const monitorFor = (instance: string, embedded: boolean) => new WorkerMonitor({ instance, commit: 'test123', beatMs: 10_000, intervalMs: 10_000, automationsEveryMs: 3_600_000, outboxEnabled: false, sessionsMode: 'auto', embedded });
const runtimeFor = (instance: string, embedded: boolean) => createWorkerRuntime({ prisma, monitor: monitorFor(instance, embedded), manager: null, cloud: null, intervalMs: 10_000, automationsEveryMs: 3_600_000, summaryEveryMs: 3_600_000, beatMs: 10_000, log: () => undefined });

test('the worker tasks run inside the API process when there is no worker service, and yield to a dedicated worker', { skip: !enabled }, async t => {
  const id = sfx();
  const tenant = await prisma.tenant.create({ data: { name: `Cantina Worker ${id}`, slug: `worker-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
  const original = await prisma.workerHeartbeat.findUnique({ where: { id: WORKER_ROW_ID } });
  t.after(async () => {
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await prisma.workerHeartbeat.deleteMany({ where: { id: WORKER_ROW_ID } });
    if (original) await prisma.workerHeartbeat.create({ data: { id: original.id, instance: original.instance, commit: original.commit, startedAt: original.startedAt, heartbeatAt: original.heartbeatAt, stoppedAt: original.stoppedAt, details: original.details ?? undefined } });
    await prisma.$disconnect();
  });
  const dueOrder = (number: number) => prisma.order.create({ data: { tenantId: tenant.id, unitId: unit.id, code: `P-${sfx()}`, number, status: 'OPEN', subtotal: 10, total: 10, scheduledFor: new Date(Date.now() - 60_000), releaseAt: new Date(Date.now() - 120_000) } });
  const released = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).releasedAt !== null;
  await prisma.workerHeartbeat.deleteMany({ where: { id: WORKER_ROW_ID } });

  await t.test('with nobody else running, the embedded runtime owns the work: it processes real tasks and proves it in the heartbeat', async () => {
    const embedded = runtimeFor(`api-${id}:1:api`, true);
    const order = await dueOrder(1);
    await embedded.beat();
    assert.equal(embedded.isLeading(), true);
    await embedded.cycle();
    assert.equal(await released(order.id), true, 'the scheduled order was really released');
    await embedded.beat();
    const health = await readWorkerHealth(prisma);
    assert.equal(health.status, 'up', health.reason ?? ''); assert.equal(health.mode, 'embedded'); assert.equal(health.commit, 'test123');
    assert.ok((health.tasks?.scheduling.runs ?? 0) >= 1 && (health.tasks?.scheduling.processed ?? 0) >= 1, 'the counters show real processing');
    assert.equal(health.tasks?.scheduling.status, 'ok');
  });

  await t.test('a dedicated worker takes over at once; the embedded runtime stands by and does not process or overwrite anything', async () => {
    const embedded = runtimeFor(`api-${id}:2:api`, true);
    await embedded.beat();
    const dedicated = runtimeFor(`srv-${id}:9`, false);
    await dedicated.beat();
    assert.equal((await readWorkerHealth(prisma)).mode, 'dedicated');
    await embedded.beat();
    assert.equal(embedded.isLeading(), false);
    assert.equal(embedded.monitor.standby, true);
    const order = await dueOrder(2);
    await embedded.cycle();
    assert.equal(await released(order.id), false, 'a standby embedded runtime does not run tasks (nothing runs twice)');
    assert.equal((await prisma.workerHeartbeat.findUniqueOrThrow({ where: { id: WORKER_ROW_ID } })).instance, `srv-${id}:9`);
    await dedicated.cycle();
    assert.equal(await released(order.id), true, 'the dedicated worker does the work');
  });

  await t.test('when the dedicated worker goes silent (crash) or announces it stopped, the embedded runtime takes over again', async () => {
    const embedded = runtimeFor(`api-${id}:3:api`, true);
    await embedded.beat();
    assert.equal(embedded.isLeading(), false, 'the dedicated worker is still fresh');
    await prisma.workerHeartbeat.update({ where: { id: WORKER_ROW_ID }, data: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } });
    await embedded.beat();
    assert.equal(embedded.isLeading(), true, 'a stale heartbeat means its owner is gone');
    assert.equal((await readWorkerHealth(prisma)).mode, 'embedded');
    const order = await dueOrder(3);
    await embedded.cycle();
    assert.equal(await released(order.id), true);
    // A clean stop of the owner hands the work over immediately.
    const dedicated = runtimeFor(`srv-${id}:10`, false);
    await dedicated.beat(); await dedicated.stop();
    assert.equal((await readWorkerHealth(prisma)).status, 'down');
    await embedded.beat();
    assert.equal(embedded.isLeading(), true);
    assert.equal((await readWorkerHealth(prisma)).status, 'up');
  });

  await t.test('a stopped standby never marks the owner as stopped', async () => {
    const owner = runtimeFor(`srv-${id}:11`, false);
    await owner.beat();
    const standby = runtimeFor(`api-${id}:4:api`, true);
    await standby.beat(); await standby.stop();
    assert.equal((await readWorkerHealth(prisma)).status, 'up');
  });

  await t.test('embedded mode is on by default only in production, and can be forced on or off', () => {
    assert.equal(embeddedWorkerEnabled({ NODE_ENV: 'production' }), true);
    assert.equal(embeddedWorkerEnabled({ NODE_ENV: 'development' }), false);
    assert.equal(embeddedWorkerEnabled({}), false);
    assert.equal(embeddedWorkerEnabled({ NODE_ENV: 'production', EMBEDDED_WORKER: 'off' }), false);
    assert.equal(embeddedWorkerEnabled({ NODE_ENV: 'development', EMBEDDED_WORKER: 'on' }), true);
  });
});
