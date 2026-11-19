import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { BACKUP_MODELS, createBackup, restoreAndCompare, scopeOf, tableOf } from '../lib/migration/backup';
import { readBackupRows, writeBackupFile, type BackupHeader } from '../lib/migration/backup-file';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1) and a role allowed to CREATE DATABASE (a temporary, isolated restore target is created and dropped).
// Own file/process: own API rate-limit budget. Uses only fictitious data.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');
const q = (identifier: string) => `"${identifier}"`;

test('RM Smart Migration backup: generation, storage, integrity, real restore into an isolated database, tenant isolation and approval gate', { skip: !enabled, timeout: 300_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const id = suffix();
  const storage = await mkdtemp(join(tmpdir(), 'rmbk-it-'));
  process.env.MIGRATION_REQUIRE_BACKUP = 'true';
  process.env.MIGRATION_BACKUP_DIR = storage;
  process.env.MIGRATION_BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  // ---- Isolated restore target: a brand-new database with the same (migrated) schema ----
  const mainUrl = new URL(process.env.DATABASE_URL!);
  const restoreDb = `rmbk_restore_${id}`;
  const restoreUrl = new URL(mainUrl); restoreUrl.pathname = `/${restoreDb}`;
  await prisma.$executeRawUnsafe(`CREATE DATABASE ${q(restoreDb)}`);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: join(__dirname, '../../../../packages/db'), env: { ...process.env, DATABASE_URL: restoreUrl.toString() }, stdio: 'pipe' });
  const restoreClient = new PrismaClient({ datasources: { db: { url: restoreUrl.toString() } } });

  const mkTenant = (label: string) => prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label.toLowerCase()}-${id}`, status: 'ACTIVE' } });
  const [tenantA, tenantB] = [await mkTenant('Bkp-A'), await mkTenant('Bkp-B')];
  const master = await prisma.user.create({ data: { name: 'Operador RM', email: `bk-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  t.after(async () => {
    for (const key of ['MIGRATION_REQUIRE_BACKUP', 'MIGRATION_BACKUP_DIR', 'MIGRATION_BACKUP_ENCRYPTION_KEY', 'MIGRATION_BACKUP_VERIFY_DATABASE_URL', 'MIGRATION_BACKUP_MAX_AGE_MINUTES']) delete process.env[key];
    await new Promise<void>(resolve => server.close(() => resolve()));
    await restoreClient.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(restoreDb)} WITH (FORCE)`);
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
    await rm(storage, { recursive: true, force: true });
  });

  // ---- Fictitious data with relationships inside and across the covered tables (two restaurants) ----
  const seed = async (tenantId: string, tag: string) => {
    const parent = await prisma.productCategory.create({ data: { tenantId, name: `${tag} Bebidas` } });
    const child = await prisma.productCategory.create({ data: { tenantId, name: `${tag} Sucos`, parentId: parent.id } });
    const supplier = await prisma.supplier.create({ data: { tenantId, name: `${tag} Fornecedor Ficticio Ltda`, document: '11222333000181' } });
    const customer = await prisma.customer.create({ data: { tenantId, name: `${tag} Cliente Ficticio`, phone: '11999990000' } });
    const products = [];
    for (let index = 0; index < 5; index += 1) products.push(await prisma.product.create({ data: { tenantId, name: `${tag} Produto ${index}`, code: `${tag}-P${index}`, price: 10.5 + index, categoryId: child.id, supplierId: supplier.id } }));
    for (const product of products) await prisma.productStockMovement.create({ data: { tenantId, productId: product.id, type: 'ADJUSTMENT', quantity: 7.125, reference: `seed:${tag}` } });
    const finCategory = await prisma.financialCategory.create({ data: { tenantId, type: 'EXPENSE', name: `${tag} Aluguel` } });
    await prisma.financialCategory.create({ data: { tenantId, type: 'EXPENSE', name: `${tag} Aluguel Filial`, parentId: finCategory.id } });
    const costCenter = await prisma.costCenter.create({ data: { tenantId, name: `${tag} Cozinha` } });
    const bank = await prisma.bankAccount.create({ data: { tenantId, name: `${tag} Conta`, initialBalance: 1234.56 } });
    await prisma.financialEntry.create({ data: { tenantId, type: 'EXPENSE', description: `${tag} Compra NF 1`, amount: 999.99, supplierId: supplier.id, costCenterId: costCenter.id, bankAccountId: bank.id, documentNumber: 'NF-1' } });
    await prisma.financialEntry.create({ data: { tenantId, type: 'INCOME', description: `${tag} Fiado`, amount: 50.5, customerId: customer.id } });
    await prisma.employee.create({ data: { tenantId, fullName: `${tag} Funcionario Ficticio`, cpf: tag === 'A' ? '52998224725' : '11144477735' } });
    const order = await prisma.order.create({ data: { tenantId, code: `MIG-${tag}-1`, status: 'COMPLETED', customerId: customer.id, subtotal: 21, total: 21 } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: products[0].id, quantity: 2, unitPrice: 10.5, total: 21 } });
    await prisma.payment.create({ data: { tenantId, orderId: order.id, method: 'CASH', amount: 21, reference: `seed:${tag}` } });
  };
  await seed(tenantA.id, 'A'); await seed(tenantB.id, 'B');

  const newSession = (tenantId: string, status = 'PREVIEWED') => prisma.migrationSession.create({ data: { tenantId, label: 'Homologação backup', engineVersion: 'test', status, sourceUnknown: true } });
  const stage = async (session: { id: string; tenantId: string }) => prisma.migrationRecord.create({ data: { sessionId: session.id, tenantId: session.tenantId, entity: 'CUSTOMER', tableName: 'clientes', rowIndex: 0, status: 'VALID', approved: true, original: { nome: 'Novo' }, normalized: { name: 'Novo' } } });
  const sessionA = await newSession(tenantA.id); await stage(sessionA);
  const sessionB = await newSession(tenantB.id); await stage(sessionB);
  const pathOf = (session: { id: string; tenantId: string }, suffixPath = '') => `/migrations/tenants/${session.tenantId}/sessions/${session.id}${suffixPath}`;
  const approve = (session: { id: string; tenantId: string }) => call('POST', pathOf(session, '/approve'), masterToken, { confirm: 'EXECUTAR' });
  const makeBackup = (session: { id: string; tenantId: string }) => call('POST', pathOf(session, '/backups'), masterToken);
  const latest = (session: { id: string }) => prisma.migrationBackup.findFirstOrThrow({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' } });
  const filePath = (backup: { fileKey: string | null }) => join(storage, backup.fileKey!);
  const reset = async (session: { id: string }) => prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'PREVIEWED', approvedAt: null, approvedById: null, backupReference: null, backupConfirmedAt: null } });
  const tenantRows = async (client: PrismaClient, tenantId: string) => Object.fromEntries(await Promise.all(BACKUP_MODELS.map(async model => [tableOf(model), (await client.$queryRawUnsafe<{ j: string }[]>(`SELECT to_jsonb(t)::text AS j FROM ${q(tableOf(model))} t WHERE ${scopeOf(tableOf(model))} ORDER BY t.id COLLATE "C"`, tenantId)).map(row => row.j)] as const)));
  const originalA = await tenantRows(prisma, tenantA.id);
  const expectedCounts = Object.fromEntries(Object.entries(originalA).map(([table, rows]) => [table, rows.length]));
  assert.ok(Object.values(expectedCounts).every(count => count > 0), 'every covered table has fictitious rows to back up');

  await t.test('capabilities expose the backup policy', async () => {
    const policy = (await call('GET', '/migrations/capabilities', masterToken)).body;
    assert.equal(policy.backupRequired, true); assert.equal(policy.backup.encrypted, true); assert.equal(policy.backup.restoreTarget, 'scratch-schema');
  });

  await t.test('no backup at all: authorization is blocked and audited', async () => {
    const response = await approve(sessionA);
    assert.equal(response.status, 422); assert.match(response.body.message, /Nenhum backup validado/);
    assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sessionA.id } })).status, 'PREVIEWED');
    assert.ok(await prisma.migrationEvent.findFirst({ where: { sessionId: sessionA.id, type: 'APPROVAL_BLOCKED' } }));
    assert.equal((await call('POST', pathOf(sessionA, '/approve'), masterToken, { confirm: 'EXECUTAR', backup: { confirmed: true, reference: 'neon-branch manual' } })).status, 422, 'an operator statement alone never releases the gate');
  });

  await t.test('storage failure: backup fails, nothing is released', async () => {
    const blocker = join(storage, 'blocker'); await writeFile(blocker, 'file where a directory is needed');
    process.env.MIGRATION_BACKUP_DIR = join(blocker, 'sub');
    const response = await makeBackup(sessionA);
    process.env.MIGRATION_BACKUP_DIR = storage;
    assert.equal(response.status, 422); assert.equal(response.body.backup.status, 'FAILED'); assert.equal(response.body.backup.stage, 'STORAGE');
    assert.equal((await approve(sessionA)).status, 422);
  });

  await t.test('restore failure (isolated target unreachable): backup is kept but not validated', async () => {
    const broken = new URL(restoreUrl); broken.pathname = `/${restoreDb}_does_not_exist`;
    process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL = broken.toString();
    const response = await makeBackup(sessionA);
    assert.equal(response.status, 422); assert.equal(response.body.backup.status, 'FAILED'); assert.equal(response.body.backup.stage, 'RESTORE');
    assert.ok(existsSync(filePath(await latest(sessionA))), 'the intact file stays available for a new validation attempt');
    const blocked = await approve(sessionA);
    assert.equal(blocked.status, 422); assert.match(blocked.body.message, /não está validado/);
  });

  let verified: Awaited<ReturnType<typeof latest>>;
  await t.test('valid backup: generated, encrypted, integrity-checked and restored into another database; data compares equal', async () => {
    process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL = restoreUrl.toString();
    const failedOne = await latest(sessionA);
    const retry = await call('POST', pathOf(sessionA, `/backups/${failedOne.id}/verify`), masterToken);
    assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.status, 'VERIFIED', 're-validation of the kept file after the target is back');
    const created = await makeBackup(sessionA);
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.status, 'VERIFIED');
    assert.equal(created.body.fileKey, undefined, 'storage path is never exposed');
    verified = await latest(sessionA);
    assert.equal(verified.tenantId, tenantA.id); assert.equal(verified.sessionId, sessionA.id); assert.equal(verified.encrypted, true);
    const manifest = verified.manifest as any; const evidence = (verified.verification as any).restore;
    assert.equal(manifest.tenantId, tenantA.id); assert.equal(manifest.backupId, verified.id); assert.ok(manifest.database.name && manifest.database.fingerprint && manifest.createdAt);
    assert.equal(evidence.mode, 'separate-database'); assert.equal(evidence.target.name, restoreDb); assert.notEqual(evidence.target.fingerprint, manifest.database.fingerprint);
    for (const table of evidence.tables) { assert.equal(table.match, true, table.table); assert.equal(table.restored.count, expectedCounts[table.table]); assert.equal(table.restored.sha256, table.backup.sha256); }
    assert.ok(evidence.relationships.length >= 6 && evidence.relationships.every((relation: any) => relation.orphans === 0));
    assert.equal(evidence.foreignTenantRows, 0);
    assert.equal((await restoreClient.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_namespace WHERE nspname LIKE 'rmbk_%'`))[0].n, 0n, 'scratch schema is dropped');

    // Independent evidence: decode the stored file and compare it with the live rows; the file never holds the other restaurant's data.
    const header = readFileSync(filePath(verified)); assert.equal(header.subarray(0, 5).toString(), 'RMBK1'); assert.equal(header.includes('Cliente Ficticio'), false);
    const decoded: Record<string, string[]> = Object.fromEntries(BACKUP_MODELS.map(model => [tableOf(model), []]));
    const reader = readBackupRows(filePath(verified), Buffer.from(process.env.MIGRATION_BACKUP_ENCRYPTION_KEY!, 'hex'), { backupId: verified.id, tenantId: tenantA.id, sessionId: sessionA.id });
    for (;;) { const next = await reader.next(); if (next.done) break; decoded[next.value.table].push(next.value.text); }
    assert.deepEqual(decoded, originalA, 'backup content equals the original rows byte for byte');
    assert.ok(Object.values(decoded).flat().every(text => !text.includes(tenantB.id) && !text.includes('"B ')), 'no data of another restaurant');

    // Full restore into the isolated database's REAL tables, with every foreign key enforced, then compare with the original.
    await restoreClient.$executeRawUnsafe(`INSERT INTO "Tenant" SELECT * FROM jsonb_populate_recordset(NULL::public."Tenant", $1::jsonb)`, JSON.stringify(await prisma.$queryRawUnsafe(`SELECT to_jsonb(t) AS j FROM "Tenant" t WHERE id = $1`, tenantA.id).then((rows: any) => rows.map((row: any) => row.j))));
    for (const model of ['ProductCategory', 'Supplier', 'Customer', 'Product', 'ProductStockMovement', 'FinancialCategory', 'CostCenter', 'BankAccount', 'FinancialEntry', 'Employee', 'Order', 'OrderItem', 'Payment'] as const) {
      const table = tableOf(model);
      await restoreClient.$executeRawUnsafe(`INSERT INTO ${q(table)} SELECT * FROM jsonb_populate_recordset(NULL::public.${q(table)}, $1::jsonb)`, `[${decoded[table].join(',')}]`);
    }
    assert.deepEqual(await tenantRows(restoreClient, tenantA.id), originalA, 'rows restored into the other database (FKs enforced) equal the originals');
    assert.equal((await restoreClient.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "Product" p JOIN "ProductCategory" c ON c.id = p."categoryId" JOIN "Supplier" s ON s.id = p."supplierId" WHERE p."tenantId" = $1`, tenantA.id))[0].n, 5n, 'relationships navigate after restore');
  });

  await t.test('validated backup releases the authorization and is recorded on the session', async () => {
    const response = await approve(sessionA);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.backupReference, new RegExp(`^rmbk:${verified.id} sha256:[0-9a-f]{16}$`));
    assert.equal(response.body.status, 'APPROVED');
  });

  await t.test('after approval a corrupted file blocks execution; session stays approved and nothing is imported', async () => {
    const before = await prisma.customer.count({ where: { tenantId: tenantA.id } });
    const bytes = readFileSync(filePath(verified)); const flipped = Buffer.from(bytes); flipped[100] ^= 0xff; writeFileSync(filePath(verified), flipped);
    const response = await call('POST', pathOf(sessionA, '/execute'), masterToken, {});
    assert.equal(response.status, 422); assert.match(response.body.message, /Execução bloqueada/);
    assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sessionA.id } })).status, 'APPROVED');
    assert.equal(await prisma.customer.count({ where: { tenantId: tenantA.id } }), before);
    assert.equal((await latest(sessionA)).status, 'INVALID');
    writeFileSync(filePath(verified), bytes);
  });

  await t.test('corrupted, truncated or missing files, altered hash, expired and foreign-database backups are refused at approval', async () => {
    const make = async () => { await reset(sessionA); const response = await makeBackup(sessionA); assert.equal(response.status, 201, JSON.stringify(response.body)); return latest(sessionA); };
    // Corrupted byte
    let backup = await make(); let bytes = readFileSync(filePath(backup)); const flipped = Buffer.from(bytes); flipped[Math.floor(bytes.length / 2)] ^= 0x55; writeFileSync(filePath(backup), flipped);
    let response = await approve(sessionA); assert.equal(response.status, 422); assert.match(response.body.message, /integridade/); assert.equal((await latest(sessionA)).status, 'INVALID');
    // Truncated
    backup = await make(); await truncate(filePath(backup), 200);
    response = await approve(sessionA); assert.equal(response.status, 422); assert.match(response.body.message, /integridade/);
    // Missing
    backup = await make(); rmSync(filePath(backup));
    response = await approve(sessionA); assert.equal(response.status, 422); assert.match(response.body.message, /integridade/);
    // Hash recorded differs (tampered record)
    backup = await make(); await prisma.migrationBackup.update({ where: { id: backup.id }, data: { sha256: 'f'.repeat(64) } });
    assert.equal((await approve(sessionA)).status, 422);
    // Expired
    backup = await make(); process.env.MIGRATION_BACKUP_MAX_AGE_MINUTES = '0.0005'; await new Promise(resolve => setTimeout(resolve, 150));
    response = await approve(sessionA); delete process.env.MIGRATION_BACKUP_MAX_AGE_MINUTES; assert.equal(response.status, 422); assert.match(response.body.message, /minutos/);
    // Generated from another database
    backup = await make(); await prisma.migrationBackup.update({ where: { id: backup.id }, data: { manifest: { ...(backup.manifest as object), database: { name: 'outro', host: 'outro', fingerprint: '0000000000000000' } } } });
    response = await approve(sessionA); assert.equal(response.status, 422); assert.match(response.body.message, /outro banco/);
    // Restore proof missing from the record
    backup = await make(); await prisma.migrationBackup.update({ where: { id: backup.id }, data: { verification: { ok: true } } });
    response = await approve(sessionA); assert.equal(response.status, 422); assert.match(response.body.message, /restauração de validação/);
    // Corrupted while being written (hook): never reaches VERIFIED
    await reset(sessionA);
    const hooked = await createBackup(await prisma.migrationSession.findUniqueOrThrow({ where: { id: sessionA.id } }), master.id, 'test', { afterExport: path => { const copy = Buffer.from(readFileSync(path)); copy[copy.length - 30] ^= 0xff; writeFileSync(path, copy); } });
    assert.equal(hooked.status, 'FAILED'); assert.match(hooked.stage ?? '', /^INTEGRITY/);
    assert.equal((await approve(sessionA)).status, 422);
  });

  await t.test('restore validation fails when the restored data does not reproduce the original (duplicate key in the file)', async () => {
    const [row] = (await prisma.$queryRawUnsafe<{ j: string }[]>(`SELECT to_jsonb(t)::text AS j FROM "Customer" t WHERE t."tenantId" = $1 LIMIT 1`, tenantA.id));
    const identity = { backupId: 'bad-restore', tenantId: tenantA.id, sessionId: sessionA.id };
    const header: BackupHeader = { type: 'header', format: 'rm-migration-backup', version: 1, ...identity, createdAt: new Date().toISOString(), engineVersion: 'test', database: { name: 'x', host: 'x', fingerprint: 'x' }, tables: BACKUP_MODELS.map(tableOf) };
    const file = join(storage, 'duplicate.rmbk');
    await writeBackupFile(file, null, header, async writer => { await writer.row('Customer', row.j); await writer.row('Customer', row.j); });
    process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL = restoreUrl.toString();
    const result = await restoreAndCompare(file, null, identity);
    assert.equal(result.ok, false); assert.match(result.error ?? '', /already exists|23505|unique/i);
  });

  await t.test('tenant isolation: another restaurant can neither see nor reuse a backup', async () => {
    process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL = restoreUrl.toString();
    await reset(sessionA); assert.equal((await makeBackup(sessionA)).status, 201);
    const backupA = await latest(sessionA);
    assert.equal((await approve(sessionB)).status, 422, 'restaurant B has no backup of its own');
    // Path-level isolation
    const wrongTenant = { id: sessionA.id, tenantId: tenantB.id };
    assert.equal((await call('GET', pathOf(wrongTenant, '/backups'), masterToken)).status, 404);
    assert.equal((await call('POST', pathOf(wrongTenant, `/backups/${backupA.id}/verify`), masterToken)).status, 404);
    assert.equal((await call('GET', pathOf(sessionB, '/backups'), masterToken)).body.items.length, 0);
    assert.equal((await call('POST', pathOf(sessionB, `/backups/${backupA.id}/verify`), masterToken)).status, 404, 'a backup id of another restaurant is not reachable through this session');
    // Tampered record: A's verified backup copied onto B's session (same file, hash, manifest and proof)
    const forged = await prisma.migrationBackup.create({ data: { tenantId: tenantB.id, sessionId: sessionB.id, createdById: master.id, status: 'VERIFIED', stage: 'VERIFIED', fileKey: backupA.fileKey, fileSize: backupA.fileSize, sha256: backupA.sha256, encrypted: true, database: backupA.database as any, manifest: backupA.manifest as any, verification: backupA.verification as any, engineVersion: 'test', verifiedAt: new Date() } });
    const response = await approve(sessionB);
    assert.equal(response.status, 422); assert.match(response.body.message, /outra empresa|operação/);
    // Manifest also forged: the file's own header still names restaurant A and the integrity check refuses it
    await prisma.migrationBackup.update({ where: { id: forged.id }, data: { manifest: { ...(backupA.manifest as object), tenantId: tenantB.id, sessionId: sessionB.id, backupId: forged.id } } });
    const second = await approve(sessionB);
    assert.equal(second.status, 422); assert.match(second.body.message, /integridade/);
    assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sessionB.id } })).status, 'PREVIEWED');
    // Restaurant A is unaffected and can still be authorized with its own backup
    assert.equal((await approve(sessionA)).status, 200);
  });

  await t.test('production data of the restaurant was only read: backup left the covered tables untouched', async () => {
    assert.deepEqual(await tenantRows(prisma, tenantA.id), originalA);
  });

});
