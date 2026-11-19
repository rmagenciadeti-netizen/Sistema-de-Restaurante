import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { RunInterrupted, runMigration } from '../lib/migration/executor';

// RM Smart Migration, stage 5 (audit): history, traceability, per-tenant isolation, permissions, failures, backup status and persistence.
// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget. Fictitious data only.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

test('RM Smart Migration audit: traceability, counts, failures, backups, isolation, permissions and persistence', { skip: !enabled, timeout: 300_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const storage = await mkdtemp(join(tmpdir(), 'rmaudit-'));
  delete process.env.MIGRATION_REQUIRE_BACKUP; delete process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL;
  process.env.MIGRATION_BACKUP_DIR = storage; process.env.MIGRATION_BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, body: type.includes('json') ? (await response.json().catch(() => null)) as any : null, text: type.includes('json') ? '' : await response.text() };
  };

  const id = suffix();
  const [tenantA, tenantB] = [await prisma.tenant.create({ data: { name: `Aud A ${id}`, slug: `aud-a-${id}`, status: 'ACTIVE' } }), await prisma.tenant.create({ data: { name: `Aud B ${id}`, slug: `aud-b-${id}`, status: 'ACTIVE' } })];
  const adminA = await prisma.user.create({ data: { tenantId: tenantA.id, name: 'Admin A', email: `aa-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const creator = await prisma.user.create({ data: { name: 'Operadora Criadora', email: `m1-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const runner = await prisma.user.create({ data: { name: 'Operador Executor', email: `m2-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const tokenOf = (userId: string, role: UserRole, tenantId: string | null) => signAccessToken({ userId, tenantId, unitId: null, role });
  const creatorToken = tokenOf(creator.id, UserRole.MASTER_ADMIN, null); const runnerToken = tokenOf(runner.id, UserRole.MASTER_ADMIN, null); const tenantToken = tokenOf(adminA.id, UserRole.ADMIN, tenantA.id);
  t.after(async () => {
    delete process.env.MIGRATION_REQUIRE_BACKUP; delete process.env.MIGRATION_BACKUP_DIR; delete process.env.MIGRATION_BACKUP_ENCRYPTION_KEY;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: [adminA.id, creator.id, runner.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminA.id, creator.id, runner.id] } } });
    await prisma.$disconnect();
    await rm(storage, { recursive: true, force: true });
  });

  type Rec = { entity: string; status: string; approved?: boolean; normalized?: Record<string, unknown>; issues?: unknown[] };
  const pathOf = (session: { id: string; tenantId: string }, tail = '') => `/migrations/tenants/${session.tenantId}/sessions/${session.id}${tail}`;
  // Sessions are created through the API (real CREATED event + audit log); staged rows are written directly so every status is exactly controlled.
  async function stagedSession(tenantId: string, label: string, records: Rec[], status = 'PREVIEWED') {
    const created = await call('POST', `/migrations/tenants/${tenantId}/sessions`, creatorToken, { label, sourceUnknown: true });
    assert.equal(created.status, 201);
    const session = { id: created.body.id as string, tenantId };
    await prisma.migrationRecord.createMany({ data: records.map((record, index) => ({ sessionId: session.id, tenantId, entity: record.entity, tableName: record.entity === 'CATEGORY' ? 'categorias' : 'clientes', rowIndex: index, status: record.status, approved: record.approved ?? false, original: { n: index } as any, normalized: (record.normalized ?? {}) as any, issues: (record.issues ?? []) as any })) });
    await prisma.migrationSession.update({ where: { id: session.id }, data: { status } });
    return session;
  }
  const category = (name: string, extra: Partial<Rec> = {}): Rec => ({ entity: 'CATEGORY', status: 'VALID', approved: true, normalized: { name }, ...extra });
  const approveAndRun = async (session: { id: string; tenantId: string }) => {
    assert.equal((await call('POST', pathOf(session, '/approve'), creatorToken, { confirm: 'EXECUTAR' })).status, 200);
    return call('POST', pathOf(session, '/execute'), runnerToken, {});
  };
  const events = async (session: { id: string; tenantId: string }, query = '') => (await call('GET', pathOf(session, `/events${query}`), creatorToken)).body;
  const countsOf = async (sessionId: string) => { const rows = await prisma.migrationRecord.groupBy({ by: ['status'], where: { sessionId }, _count: true }); return Object.fromEntries(rows.map(row => [row.status, row._count])) as Record<string, number>; };

  // Another restaurant with its own finished session, whose history must stay out of reach.
  const sessionB = await stagedSession(tenantB.id, 'Sessão da empresa B', [category('B-Bebidas'), category('B-Lanches')]);
  assert.equal((await approveAndRun(sessionB)).status, 200);
  const eventsOfB = await prisma.migrationEvent.count({ where: { sessionId: sessionB.id } });

  let success: { id: string; tenantId: string };
  await t.test('success with rejected / ignored / pending records: events, actors, counts and report agree', async () => {
    success = await stagedSession(tenantA.id, 'Sucesso com ressalvas', [
      category('Bebidas'), category('Lanches'), category('Sobremesas'),
      { entity: 'CUSTOMER', status: 'REJECTED', issues: [{ field: 'phone', severity: 'error', code: 'required', message: 'Telefone obrigatório ausente.' }] },
      { entity: 'CUSTOMER', status: 'IGNORED' },
      { entity: 'CUSTOMER', status: 'DIVERGENT', issues: [{ field: 'document', severity: 'review', code: 'invalid_cpf', message: 'CPF inválido.' }], normalized: { name: 'Pendente', phone: '11999990000' } },
    ]);
    const ran = await approveAndRun(success);
    assert.equal(ran.status, 200, JSON.stringify(ran.body)); assert.equal(ran.body.status, 'COMPLETED');
    const timeline = (await events(success)).items as any[];
    const types = timeline.map(event => event.type);
    for (const type of ['CREATED', 'APPROVED', 'STARTED', 'BATCH_DONE', 'COMPLETED']) assert.ok(types.includes(type), `event ${type}`);
    assert.ok(timeline.every(event => event.tenantId === tenantA.id && event.sessionId === success.id), 'every event belongs to this restaurant and session');
    assert.deepEqual([...timeline].map(event => +new Date(event.createdAt)), [...timeline].map(event => +new Date(event.createdAt)).sort((a, b) => a - b), 'chronological');
    const by = (type: string) => timeline.find(event => event.type === type);
    assert.equal(by('CREATED').actorUserId, creator.id); assert.equal(by('APPROVED').actorUserId, creator.id); assert.equal(by('STARTED').actorUserId, runner.id); assert.equal(by('COMPLETED').actorUserId, runner.id);
    assert.equal(by('CREATED').actorName, 'Operadora Criadora', 'who did it is shown by name, not only by id');
    assert.equal(by('STARTED').actorName, 'Operador Executor');
    // Counts: database ↔ COMPLETED event ↔ report ↔ stored summary
    const db = await countsOf(success.id);
    assert.deepEqual(db, { IMPORTED: 3, REJECTED: 1, IGNORED: 1, DIVERGENT: 1 });
    const completed = by('COMPLETED').data.counts;
    assert.equal(completed.read, 6); assert.equal(completed.imported, db.IMPORTED); assert.equal(completed.rejected, db.REJECTED); assert.equal(completed.ignored, db.IGNORED); assert.equal(completed.pendingDivergences, db.DIVERGENT);
    const report = (await call('GET', pathOf(success, '/report'), creatorToken)).body;
    assert.deepEqual(report.result.totals, { read: 6, imported: 3, duplicates: 0, rejected: 1, failed: 0, ignored: 1, pending: 1 });
    const row = (entity: string) => report.comparison.find((item: any) => item.entity === entity);
    assert.deepEqual([row('CATEGORY').read, row('CATEGORY').imported, row('CUSTOMER').read, row('CUSTOMER').rejected, row('CUSTOMER').ignored, row('CUSTOMER').pending], [3, 3, 3, 1, 1, 1], 'result by table');
    assert.equal(report.groups.reduce((sum: number, group: any) => sum + group.read, 0), report.result.totals.read);
    const summary = (await prisma.migrationSession.findUniqueOrThrow({ where: { id: success.id } })).summary as any;
    assert.equal(Object.values<any>(summary.byEntity).reduce((sum, bucket) => sum + (bucket.total ?? 0), 0), report.result.totals.read, 'stored summary equals the report');
    assert.equal(report.identification.operator, 'Operadora Criadora'); assert.equal(report.identification.approvedBy, 'Operadora Criadora'); assert.equal(report.identification.executedBy, 'Operador Executor', 'who executed it');
    assert.equal(report.identification.restaurant, `Aud A ${id}`); assert.equal(report.identification.migrationId, success.id);
    assert.ok(report.identification.startedAt && report.identification.finishedAt && report.identification.approvedAt && report.identification.createdAt);
    assert.ok(report.pendencies.some((item: any) => item.status === 'REJECTED' && item.messages.includes('Telefone obrigatório ausente.')), 'rejection reason is reported');
    assert.ok(report.pendencies.some((item: any) => item.status === 'DIVERGENT' && item.messages.includes('CPF inválido.')));
    assert.match(report.overall.outcome, /WITH_CAVEATS|PARTIAL/);
    const csv = (await call('GET', pathOf(success, '/report.csv'), creatorToken)).text;
    assert.equal(csv.trim().split('\r\n').length - 1 >= 6, true); assert.match(csv, /Telefone obrigatório ausente/);
    // Database audit log (separate from the session timeline) is persisted per tenant with the acting user
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'MigrationSession', entityId: success.id } });
    assert.deepEqual(audits.map(entry => entry.action).sort(), ['MIGRATION_APPROVED', 'MIGRATION_COMPLETED', 'MIGRATION_CREATED', 'MIGRATION_EXECUTE_REQUESTED']);
    assert.ok(audits.every(entry => entry.tenantId === tenantA.id));
    assert.equal(audits.find(entry => entry.action === 'MIGRATION_EXECUTE_REQUESTED')!.actorUserId, runner.id); assert.equal(audits.find(entry => entry.action === 'MIGRATION_CREATED')!.actorUserId, creator.id);
    assert.deepEqual(audits.find(entry => entry.action === 'MIGRATION_COMPLETED')!.metadata && (audits.find(entry => entry.action === 'MIGRATION_COMPLETED')!.metadata as any).counts.imported, 3);
  });

  await t.test('failed records: counted as failures, reason kept in the report, CSV and events; session still completes honestly', async () => {
    const session = await stagedSession(tenantA.id, 'Com falha', [category('Boa'), category('Filha', { normalized: { name: 'Filha', parentName: 'Categoria que não existe' } })]);
    const ran = await approveAndRun(session); assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const db = await countsOf(session.id); assert.deepEqual(db, { IMPORTED: 1, FAILED: 1 });
    const report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.equal(report.result.totals.failed, 1); assert.equal(report.result.totals.imported, 1);
    assert.equal(report.errors.length, 1); assert.match(report.errors[0].messages.join(' '), /Relacionamento não resolvido/);
    assert.notEqual(report.overall.outcome, 'VALIDATED', 'a run with failures is never reported as a plain success');
    assert.match((await call('GET', pathOf(session, '/report.csv'), creatorToken)).text, /Relacionamento não resolvido/);
    const completed = (await events(session)).items.find((event: any) => event.type === 'COMPLETED'); assert.equal(completed.data.counts.failed, 1);
  });

  await t.test('interrupted run: interruption and resume are recorded with their actors; counts stay consistent', async () => {
    const session = await stagedSession(tenantA.id, 'Interrompida', Array.from({ length: 6 }, (_, index) => category(`Cat ${index}`)));
    assert.equal((await call('POST', pathOf(session, '/approve'), creatorToken, { confirm: 'EXECUTAR' })).status, 200);
    let seen = 0;
    const run = await runMigration(await prisma.migrationSession.findUniqueOrThrow({ where: { id: session.id } }), { id: creator.id, label: 'Operadora Criadora' }, { batchSize: 2, hooks: { beforeRecord: () => { if (++seen === 4) throw new RunInterrupted('queda simulada'); } } });
    assert.equal(run.status, 'INTERRUPTED');
    let report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.equal(report.overall.outcome, 'INTERRUPTED'); assert.equal(report.overall.status, 'INTERRUPTED');
    const interrupted = (await events(session)).items.find((event: any) => event.type === 'INTERRUPTED');
    assert.ok(interrupted && /queda simulada/.test(interrupted.message)); assert.equal(interrupted.actorUserId, creator.id);
    const mid = report.result.totals; assert.equal(mid.read, 6); assert.equal(mid.imported + mid.pending, 6, 'processed + still pending = all'); assert.ok(mid.imported > 0 && mid.pending > 0);
    const resumed = await call('POST', pathOf(session, '/resume'), runnerToken, {}); assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.deepEqual(report.result.totals, { read: 6, imported: 6, duplicates: 0, rejected: 0, failed: 0, ignored: 0, pending: 0 });
    const timeline = (await events(session)).items as any[];
    assert.deepEqual(['STARTED', 'INTERRUPTED', 'RESUMED', 'COMPLETED'].map(type => timeline.findIndex(event => event.type === type)).every((value, index, all) => value >= 0 && (index === 0 || value > all[index - 1])), true, 'ordered history');
    assert.equal(timeline.find(event => event.type === 'RESUMED').actorUserId, runner.id);
    assert.equal(await prisma.productCategory.count({ where: { tenantId: tenantA.id, name: { startsWith: 'Cat ' } } }), 6, 'resume never duplicates what was already imported');
  });

  await t.test('session never executed: honest "not executed" report, no execution events, nothing imported', async () => {
    const session = await stagedSession(tenantA.id, 'Sem execução', [category('Nunca'), { entity: 'CUSTOMER', status: 'REJECTED' }]);
    const report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.equal(report.overall.outcome, null); assert.equal(report.overall.outcomeLabel, 'Ainda não executada');
    assert.equal(report.result.totals.imported, 0); assert.equal(report.result.durationSeconds, null); assert.equal(report.identification.startedAt, null); assert.equal(report.identification.finishedAt, null);
    assert.equal(report.identification.executedBy ?? null, null); assert.deepEqual(report.backups, []);
    const types = (await events(session)).items.map((event: any) => event.type); assert.deepEqual(types, ['CREATED']);
    assert.equal(await prisma.productCategory.count({ where: { tenantId: tenantA.id, name: 'Nunca' } }), 0);
  });

  await t.test('backup status in the audit: missing, failed, valid and later-corrupted backups block and are recorded', async () => {
    process.env.MIGRATION_REQUIRE_BACKUP = 'true';
    const session = await stagedSession(tenantA.id, 'Backup', [category('Com backup')]);
    const blocked = await call('POST', pathOf(session, '/approve'), creatorToken, { confirm: 'EXECUTAR' });
    assert.equal(blocked.status, 422);
    let timeline = (await events(session)).items as any[];
    const block = timeline.find(event => event.type === 'APPROVAL_BLOCKED'); assert.ok(block && block.actorUserId === creator.id && /Nenhum backup validado/.test(block.message));
    assert.equal((await call('GET', pathOf(session, '/report'), creatorToken)).body.backups.length, 0);
    const made = await call('POST', pathOf(session, '/backups'), creatorToken); assert.equal(made.status, 201, JSON.stringify(made.body));
    let report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.equal(report.backups.length, 1); assert.equal(report.backups[0].status, 'VERIFIED'); assert.equal(report.backups[0].restoreVerified, true); assert.ok(report.backups[0].verifiedAt && report.backups[0].createdAt && /^[0-9a-f]{64}$/.test(report.backups[0].sha256));
    assert.equal(report.backups[0].fileKey, undefined, 'storage path is not exposed');
    assert.equal((await call('POST', pathOf(session, '/approve'), creatorToken, { confirm: 'EXECUTAR' })).status, 200);
    const record = await prisma.migrationBackup.findFirstOrThrow({ where: { sessionId: session.id } });
    const file = join(storage, record.fileKey!); const bytes = readFileSync(file); const flipped = Buffer.from(bytes); flipped[100] ^= 0xff; writeFileSync(file, flipped);
    const execute = await call('POST', pathOf(session, '/execute'), runnerToken, {});
    assert.equal(execute.status, 422); assert.match(execute.body.message, /Execução bloqueada/);
    timeline = (await events(session)).items;
    const execBlock = timeline.find(event => event.type === 'EXECUTION_BLOCKED'); assert.ok(execBlock, 'a blocked execution is recorded in the audit trail');
    assert.equal(execBlock.actorUserId, runner.id);
    report = (await call('GET', pathOf(session, '/report'), creatorToken)).body;
    assert.equal(report.backups[0].status, 'INVALID'); assert.match(report.backups[0].error, /integridade|hash|corromp/i);
    assert.equal(report.result.totals.imported, 0); assert.equal(await prisma.productCategory.count({ where: { tenantId: tenantA.id, name: 'Com backup' } }), 0);
    // A failed backup attempt is also visible
    const failedSession = await stagedSession(tenantA.id, 'Backup falho', [category('X')]);
    const blocker = join(storage, 'blocker'); writeFileSync(blocker, 'a file where a directory is needed'); process.env.MIGRATION_BACKUP_DIR = join(blocker, 'sub');
    const failedBackup = await call('POST', pathOf(failedSession, '/backups'), creatorToken); process.env.MIGRATION_BACKUP_DIR = storage;
    assert.equal(failedBackup.status, 422);
    assert.equal((await call('GET', pathOf(failedSession, '/report'), creatorToken)).body.backups[0].status, 'FAILED');
    assert.ok((await events(failedSession)).items.some((event: any) => event.type === 'BACKUP_FAILED'));
    delete process.env.MIGRATION_REQUIRE_BACKUP;
  });

  await t.test('isolation: another restaurant\'s history, report, exports and backups are unreachable; lists never mix', async () => {
    for (const tail of ['', '/events', '/report', '/report.csv', '/report.pdf', '/backups', '/records']) assert.equal((await call('GET', pathOf({ id: sessionB.id, tenantId: tenantA.id }, tail), creatorToken)).status, 404, `B's session through A's path ${tail}`);
    for (const tail of ['', '/events', '/report']) assert.equal((await call('GET', pathOf({ id: success.id, tenantId: tenantB.id }, tail), creatorToken)).status, 404, `A's session through B's path ${tail}`);
    const listA = (await call('GET', `/migrations/tenants/${tenantA.id}/sessions`, creatorToken)).body; const listB = (await call('GET', `/migrations/tenants/${tenantB.id}/sessions`, creatorToken)).body;
    assert.ok(listA.items.length >= 5 && listA.items.every((item: any) => item.id !== sessionB.id)); assert.deepEqual(listB.items.map((item: any) => item.id), [sessionB.id]);
    assert.equal(listB.tenant.id, tenantB.id);
    assert.equal(await prisma.migrationEvent.count({ where: { sessionId: sessionB.id } }), eventsOfB, "B's history unchanged by A's activity");
    assert.equal(await prisma.migrationEvent.count({ where: { sessionId: sessionB.id, tenantId: { not: tenantB.id } } }), 0);
    assert.equal(await prisma.migrationEvent.count({ where: { tenantId: tenantA.id, session: { tenantId: { not: tenantA.id } } } }), 0, 'no event points to a session of another restaurant');
    assert.equal(await prisma.auditLog.count({ where: { entityType: 'MigrationSession', entityId: sessionB.id, tenantId: { not: tenantB.id } } }), 0);
    assert.equal((await call('GET', `/migrations/tenants/${randomBytes(4).toString('hex')}/sessions`, creatorToken)).status, 400, 'malformed id');
    assert.equal((await call('GET', `/migrations/tenants/00000000-0000-4000-8000-000000000000/sessions`, creatorToken)).status, 404, 'unknown restaurant');
  });

  await t.test('permissions: only MASTER_ADMIN; restaurant users and anonymous callers are refused on every audit endpoint', async () => {
    for (const tail of ['', '/events', '/report', '/report.csv', '/report.pdf', '/backups']) {
      assert.equal((await call('GET', pathOf(success, tail), tenantToken)).status, 403, `restaurant admin ${tail}`);
      assert.equal((await call('GET', pathOf(success, tail), null)).status, 401, `anonymous ${tail}`);
    }
    assert.equal((await call('GET', `/migrations/tenants/${tenantA.id}/sessions`, tenantToken)).status, 403);
    assert.equal((await call('GET', pathOf(success, '/events'), 'not-a-token')).status, 401);
  });

  await t.test('long histories: pagination, filters and ordering keep the final events reachable; session list is paginated', async () => {
    const session = await stagedSession(tenantA.id, 'Histórico longo', [category('Longa')]);
    await prisma.migrationEvent.createMany({ data: Array.from({ length: 1200 }, (_, index) => ({ sessionId: session.id, tenantId: tenantA.id, actorUserId: runner.id, type: index === 1199 ? 'COMPLETED' : 'BATCH_DONE', message: `Lote ${index + 1}`, createdAt: new Date(Date.now() + 1000 + index) })) });
    const total = await prisma.migrationEvent.count({ where: { sessionId: session.id } }); assert.equal(total, 1201);
    const newest = await events(session, '?order=desc&pageSize=10'); assert.equal(newest.total, total); assert.equal(newest.items[0].type, 'COMPLETED', 'the newest event is reachable even with more than 1000 events');
    const seen = new Set<string>(); for (let page = 1; page <= 3; page++) for (const event of (await events(session, `?order=asc&page=${page}&pageSize=500`)).items) seen.add(event.id);
    assert.equal(seen.size, total, 'pages are disjoint and cover every event');
    assert.equal((await events(session, '?type=COMPLETED')).total, 1); assert.equal((await events(session, '?type=BATCH_DONE&pageSize=5')).items.length, 5);
    assert.equal((await call('GET', pathOf(session, '/events?pageSize=100000'), creatorToken)).status, 400, 'bounded page size');
    assert.equal((await call('GET', pathOf(session, '/events?order=sideways'), creatorToken)).status, 400);
    await prisma.migrationSession.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ tenantId: tenantB.id, label: `Histórico ${index}`, engineVersion: 't', status: index % 2 ? 'COMPLETED' : 'CANCELLED', createdAt: new Date(Date.now() - index * 1000) })) });
    const first = (await call('GET', `/migrations/tenants/${tenantB.id}/sessions?pageSize=50`, creatorToken)).body; const third = (await call('GET', `/migrations/tenants/${tenantB.id}/sessions?pageSize=50&page=3`, creatorToken)).body;
    assert.equal(first.total, 106); assert.equal(first.items.length, 50); assert.equal(third.items.length, 6);
    const completedOnly = (await call('GET', `/migrations/tenants/${tenantB.id}/sessions?status=COMPLETED&pageSize=100`, creatorToken)).body;
    assert.ok(completedOnly.items.length > 0 && completedOnly.items.every((item: any) => item.status === 'COMPLETED'));
    assert.equal((await call('GET', `/migrations/tenants/${tenantB.id}/sessions?status=NOPE`, creatorToken)).status, 400);
  });

  await t.test('persistence: after restarting the application the same history and report are served from the database', async () => {
    const before = { events: (await events(success)).items, report: (await call('GET', pathOf(success, '/report'), creatorToken)).body, sessions: (await call('GET', `/migrations/tenants/${tenantA.id}/sessions`, creatorToken)).body.items.map((item: any) => item.id) };
    await prisma.$disconnect(); // this process drops its own connections; a brand-new process (new Prisma client, new app instance) then reads everything back
    const script = `const { app } = require('./src/index'); const s = app.listen(0, '127.0.0.1', async () => { const p = s.address().port; const get = async (u) => (await fetch('http://127.0.0.1:' + p + '/api/v1' + u, { headers: { authorization: 'Bearer ' + process.env.AUDIT_TOKEN } })).json();
      const out = { events: (await get(process.env.AUDIT_EVENTS)).items, report: await get(process.env.AUDIT_REPORT), sessions: (await get(process.env.AUDIT_LIST)).items.map(i => i.id) }; console.log('@@' + JSON.stringify(out)); s.close(); process.exit(0); });`;
    const env: NodeJS.ProcessEnv = { ...process.env, AUDIT_TOKEN: creatorToken, AUDIT_EVENTS: pathOf(success, '/events'), AUDIT_REPORT: pathOf(success, '/report'), AUDIT_LIST: `/migrations/tenants/${tenantA.id}/sessions` };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [require.resolve('tsx/cli'), '-e', script], { cwd: join(__dirname, '../..'), env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(child.status, 0, child.stderr.slice(-600));
    const after = JSON.parse(child.stdout.split('@@').pop()!);
    delete before.report.generatedAt; delete after.report.generatedAt;
    assert.deepEqual(after.events, before.events, 'events identical after restart'); assert.deepEqual(after.report, before.report, 'report identical after restart'); assert.deepEqual(after.sessions, before.sessions);
    assert.ok(after.events.length > 0 && after.report.result.totals.imported === 3);
  });
});
