import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { RunInterrupted, runMigration } from '../lib/migration/executor';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Kept in its own file/process so it has its own API rate-limit budget.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

const dump = [
  'CREATE TABLE tb_grp (cod_grp int, nm_grp varchar(40));', "INSERT INTO tb_grp VALUES (10,'Lanches'),(20,'Bebidas');",
  'CREATE TABLE itens_cardapio (cod_item int, desc_item varchar(80), pv numeric(10,2), cod_grp int, ean varchar(14), estoque_atual varchar(10), senha_gerente varchar(20));',
  "INSERT INTO itens_cardapio VALUES (1,'X-Salada','25,90',10,'7891000100103','10','1234'),(2,'Coca 350ml','6.50',20,'7894900011517','5,5','1234'),(3,'=SOMA(A1)','9,00',10,NULL,NULL,'1234'),(4,'Sem grupo','9,00',NULL,NULL,'0','1234'),(5,'Preco ruim','abc',10,NULL,NULL,'1234'),(6,'Suco','7,00',20,NULL,NULL,'1234');",
  'CREATE TABLE pessoas (id int, nome_completo varchar(80), cpf_cnpj varchar(20), celular varchar(20), mail varchar(60));',
  "INSERT INTO pessoas VALUES (1,'Ana Souza','529.982.247-25','(11) 91234-5678','ANA@EXEMPLO.COM'),(2,'Bruno','','',''),(3,'Carla','123.456.789-00','11 98888-7777',NULL),(4,'Davi','','11 97777-6666',NULL);",
].join('\n');

test('RM Smart Migration: end-to-end import, review, interruption/resume, isolation and rollback', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string | null, body?: unknown, raw?: Buffer) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'application/octet-stream' } : {}) }, body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, type, body: type.includes('json') ? (await response.json().catch(() => null)) as any : null, text: type.includes('json') ? '' : await response.text() };
  };
  const id = suffix();
  const tenantA = await prisma.tenant.create({ data: { name: `Mig A ${id}`, slug: `mig-a-${id}`, status: 'ACTIVE' } });
  const tenantB = await prisma.tenant.create({ data: { name: `Mig B ${id}`, slug: `mig-b-${id}`, status: 'ACTIVE' } });
  const adminA = await prisma.user.create({ data: { tenantId: tenantA.id, name: 'Admin A', email: `a-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const master = await prisma.user.create({ data: { name: 'Operador RM', email: `m-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const tenantToken = signAccessToken({ userId: adminA.id, tenantId: tenantA.id, unitId: null, role: UserRole.ADMIN });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: tenantA.id } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.migrationMappingTemplate.deleteMany({ where: { createdById: master.id } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [master.id, adminA.id] } } });
    await prisma.$disconnect();
  });

  // Data that must never be touched by a migration of tenant A.
  await prisma.productCategory.create({ data: { tenantId: tenantB.id, name: 'Lanches' } });
  await prisma.product.create({ data: { tenantId: tenantB.id, name: 'X-Salada', code: '1', price: 99 } });
  await prisma.customer.create({ data: { tenantId: tenantB.id, name: 'Ana Souza', phone: '11912345678' } });
  const snapshotB = async () => ({ products: await prisma.product.findMany({ where: { tenantId: tenantB.id }, select: { name: true, price: true, code: true } }), customers: await prisma.customer.count({ where: { tenantId: tenantB.id } }), categories: await prisma.productCategory.count({ where: { tenantId: tenantB.id } }) });
  const beforeB = await snapshotB();
  await prisma.product.create({ data: { tenantId: tenantA.id, name: 'Existente', code: '99', price: 5 } });

  // ---- Access control ----
  assert.equal((await call('GET', '/migrations/capabilities', null)).status, 401);
  assert.equal((await call('GET', '/migrations/capabilities', tenantToken)).status, 403, 'restaurant users cannot reach the engine');
  const capabilities = await call('GET', '/migrations/capabilities', masterToken);
  assert.equal(capabilities.status, 200); assert.ok(capabilities.body.unsupportedFormats.length > 0);

  const created = await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, masterToken, { label: 'Sistema legado', sourceUnknown: true });
  assert.equal(created.status, 201);
  const sid = created.body.id as string; const path = (suffixPath = '', tenant = tenantA.id) => `/migrations/tenants/${tenant}/sessions/${sid}${suffixPath}`;
  assert.equal((await call('GET', path('', tenantB.id), masterToken)).status, 404, 'a session is unreachable through another tenant');
  assert.equal((await call('POST', path('/analyze', tenantB.id), masterToken, {})).status, 404);

  // ---- Upload and analysis ----
  assert.equal((await call('POST', path('/files?name=banco.sqlite'), masterToken, undefined, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]))).status, 415);
  assert.equal((await call('POST', path('/files?name=legado.sql'), masterToken, undefined, Buffer.from(dump))).status, 201);
  assert.equal((await call('POST', path('/files?name=legado.sql'), masterToken, undefined, Buffer.from(dump))).status, 409, 'same file twice');
  assert.equal((await call('POST', path('/files?name=quebrado.xlsx'), masterToken, undefined, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).status, 201, 'format problems are reported at analysis');
  const analysis = await call('POST', path('/analyze'), masterToken, {});
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  assert.equal(analysis.body.analysis.errors.length, 1, 'unreadable file is reported, not hidden');
  const tables = Object.values(analysis.body.mapping.tables) as any[];
  assert.deepEqual(tables.map(table => table.entity).sort(), ['CATEGORY', 'CUSTOMER', 'PRODUCT']);
  assert.equal((await call('POST', path('/preview'), masterToken, {})).status, 422, 'preview needs an approved mapping');
  const approvals = Object.fromEntries(tables.map(table => [table.key, { approved: true }]));
  assert.equal((await call('PUT', path('/mapping'), masterToken, { tables: { ...approvals, [tables[0].key]: { approved: true, columns: { nonexistent: 'name' } } } })).status, 422);
  assert.equal((await call('PUT', path('/mapping'), masterToken, { tables: approvals })).status, 200);
  assert.ok(await prisma.migrationMappingTemplate.count({ where: { createdById: master.id } }) >= 3, 'approved mappings are stored for reuse');

  // ---- Preview and human review ----
  const preview = await call('POST', path('/preview'), masterToken, {});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.summary.byEntity.PRODUCT.REJECTED, 1); assert.equal(preview.body.summary.byEntity.CUSTOMER.DIVERGENT, 1);
  const records = async (query: string) => (await call('GET', path(`/records?${query}`), masterToken)).body.items as any[];
  const bad = (await records('entity=PRODUCT&status=REJECTED'))[0];
  assert.equal(bad.original.pv, 'abc'); assert.ok(bad.issues.length > 0);
  const fixed = await call('PATCH', path(`/records/${bad.id}`), masterToken, { values: { price: '10,00' } });
  assert.equal(fixed.status, 200); assert.equal(fixed.body.status, 'VALID'); assert.equal(fixed.body.normalized.price, '10');
  assert.ok(fixed.body.corrections.some((correction: any) => correction.rule === 'manual'), 'manual correction is audited');
  assert.equal(fixed.body.original.pv, 'abc', 'source value is preserved');
  const invalidCpf = (await records('entity=CUSTOMER&status=DIVERGENT'))[0];
  assert.equal(invalidCpf.approved, false);
  const noPhone = (await records('entity=CUSTOMER&status=REJECTED'))[0];
  assert.equal((await call('PATCH', path(`/records/${noPhone.id}`), masterToken, { approve: true })).status, 422, 'rejected records cannot be approved');
  assert.equal((await call('PATCH', path(`/records/${noPhone.id}`), masterToken, { ignore: true })).status, 200);
  const cpfFix = await call('PATCH', path(`/records/${invalidCpf.id}`), masterToken, { values: { document: null } });
  assert.equal(cpfFix.body.status, 'VALID');
  assert.equal((await call('POST', path('/approve'), masterToken, {})).status, 422, 'explicit authorisation is mandatory');
  assert.equal((await call('POST', path('/execute'), masterToken, {})).status, 409, 'cannot run before approval');
  assert.equal((await call('POST', path('/approve'), masterToken, { confirm: 'EXECUTAR' })).status, 200);
  assert.equal((await call('PATCH', path(`/records/${bad.id}`), masterToken, { ignore: true })).status, 409, 'locked after approval');

  // ---- Failure in the middle of the import, then safe resume ----
  const session = await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } });
  let seen = 0;
  const interrupted = await runMigration(session, { id: master.id, label: 'Operador RM' }, { batchSize: 2, hooks: { beforeRecord: () => { if (++seen === 5) throw new RunInterrupted('queda simulada'); } } });
  assert.equal(interrupted.status, 'INTERRUPTED');
  assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } })).status, 'INTERRUPTED');
  const importedBefore = await prisma.migrationRecord.count({ where: { sessionId: sid, status: 'IMPORTED' } });
  assert.ok(importedBefore > 0 && importedBefore < 11);
  const resumed = await call('POST', path('/resume'), masterToken, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.status, 'COMPLETED');
  assert.equal(resumed.body.outcome, 'WITH_CAVEATS', 'rejected/pending data prevents a plain success');
  assert.equal((await call('POST', path('/execute'), masterToken, {})).status, 409, 'a finished migration cannot be run again');

  // ---- Result in the restaurant database ----
  const products = await prisma.product.findMany({ where: { tenantId: tenantA.id }, include: { category: true, stockMovements: true } });
  assert.equal(products.length, 1 + 6, 'pre-existing + six importable products; no duplicates after resume');
  const salad = products.find(product => product.name === 'X-Salada')!;
  assert.equal(salad.price.toString(), '25.9'); assert.equal(salad.category?.name, 'Lanches'); assert.equal(salad.barcode, '7891000100103');
  assert.equal(salad.stockControlled, true); assert.equal(salad.stockQuantity.toString(), '10'); assert.equal(salad.stockMovements.length, 1);
  assert.equal(products.find(product => product.name === 'Coca 350ml')!.stockQuantity.toString(), '5.5');
  assert.equal(products.find(product => product.name === 'Sem grupo')!.categoryId, null);
  assert.equal((await prisma.productCategory.findMany({ where: { tenantId: tenantA.id }, select: { name: true } })).map(category => category.name).sort().join(), 'Bebidas,Lanches');
  const customers = await prisma.customer.findMany({ where: { tenantId: tenantA.id } });
  assert.deepEqual(customers.map(customer => customer.name).sort(), ['Ana Souza', 'Carla', 'Davi']);
  assert.ok(customers.every(customer => customer.marketingConsent === false), 'marketing consent is never inferred');
  assert.equal(customers.find(customer => customer.name === 'Ana Souza')!.email, 'ana@exemplo.com');
  assert.deepEqual(await snapshotB(), beforeB, 'another restaurant is never altered');

  // ---- Audit and reports ----
  const events = (await call('GET', path('/events'), masterToken)).body.items as any[];
  for (const type of ['CREATED', 'ANALYZED', 'PREVIEWED', 'RECORD_REVIEWED', 'APPROVED', 'INTERRUPTED', 'RESUMED', 'COMPLETED']) assert.ok(events.some(event => event.type === type), `event ${type}`);
  assert.ok(await prisma.auditLog.count({ where: { tenantId: tenantA.id, action: 'MIGRATION_COMPLETED' } }) === 1);
  const report = (await call('GET', path('/report'), masterToken)).body;
  assert.equal(report.overall.outcome, 'WITH_CAVEATS'); assert.equal(report.identification.operator, 'Operador RM'); assert.equal(report.result.totals.imported, 11);
  assert.ok(report.integrity.every((check: any) => check.ok)); assert.ok(report.corrections.total > 0);
  const csv = await call('GET', path('/report.csv'), masterToken);
  assert.match(csv.type, /text\/csv/); assert.match(csv.text, /decimal_format/); assert.ok(!/;=SOMA/.test(csv.text), 'formula-like source values are neutralised in the CSV');
  const pdf = await call('GET', path('/report.pdf'), masterToken); assert.match(pdf.type, /application\/pdf/); assert.ok(pdf.text.startsWith('%PDF'));

  // ---- Safe rollback: only what this migration created and nothing built on top of it ----
  const sold = products.find(product => product.name === 'Coca 350ml')!;
  await prisma.order.create({ data: { tenantId: tenantA.id, code: `M${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 6.5, total: 6.5, createdByUserId: adminA.id, items: { create: [{ productId: sold.id, quantity: 1, unitPrice: 6.5, total: 6.5 }] } } });
  const edited = products.find(product => product.name === 'Suco')!;
  await prisma.migrationRecord.updateMany({ where: { sessionId: sid, targetId: edited.id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
  assert.equal((await call('POST', path('/rollback'), masterToken, {})).status, 422);
  const rollback = await call('POST', path('/rollback'), masterToken, { confirm: 'REVERTER' });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
  const blockedReasons = rollback.body.blocked.map((item: any) => item.reason).join(' | ');
  assert.match(blockedReasons, /pedidos/); assert.match(blockedReasons, /alterado depois/); assert.match(blockedReasons, /Categoria ainda possui produtos/);
  const remaining = (await prisma.product.findMany({ where: { tenantId: tenantA.id }, select: { name: true } })).map(product => product.name).sort();
  assert.deepEqual(remaining, ['Coca 350ml', 'Existente', 'Suco']);
  assert.equal((await prisma.customer.count({ where: { tenantId: tenantA.id } })), 0, 'customers created by the migration are removed');
  assert.ok(remaining.includes('Existente'), 'pre-existing data survives');
  assert.deepEqual(await snapshotB(), beforeB);
  assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } })).status, 'COMPLETED', 'partial rollback keeps the session open');

  // ---- Retention ----
  assert.equal((await call('POST', path('/purge-files'), masterToken, {})).body.purged, 2);
  assert.equal(await prisma.migrationFile.count({ where: { sessionId: sid, content: { not: null } } }), 0);

  // ---- Approved mappings are reused for the same structure (never assumed for a different one) ----
  const again = (await call('POST', `/migrations/tenants/${tenantB.id}/sessions`, masterToken, { label: 'Mesmo sistema', sourceUnknown: true })).body.id as string;
  await call('POST', `/migrations/tenants/${tenantB.id}/sessions/${again}/files?name=legado.sql`, masterToken, undefined, Buffer.from(dump));
  const reanalysis = (await call('POST', `/migrations/tenants/${tenantB.id}/sessions/${again}/analyze`, masterToken, {})).body;
  const itemsTable = (Object.values(reanalysis.mapping.tables) as any[]).find(table => table.entity === 'PRODUCT');
  assert.equal(itemsTable.columns.pv.source, 'template'); assert.equal(itemsTable.columns.pv.target, 'price');
  assert.equal(itemsTable.approved, false, 'a reused mapping still needs explicit approval');

  // ---- Cancelling a live run: the runner stops itself and nothing is written afterwards ----
  const csvSession = (await call('POST', `/migrations/tenants/${tenantB.id}/sessions`, masterToken, { label: 'Clientes CSV', sourceSystem: 'Planilha' })).body.id as string;
  const cp = (suffixPath: string) => `/migrations/tenants/${tenantB.id}/sessions/${csvSession}${suffixPath}`;
  const customersCsv = ['nome;telefone', ...Array.from({ length: 6 }, (_, index) => `Cliente ${index + 1};11 9${index}000-111${index}`)].join('\n');
  assert.equal((await call('POST', cp('/files?name=clientes.csv'), masterToken, undefined, Buffer.from(customersCsv))).status, 201);
  const csvTable = (Object.values((await call('POST', cp('/analyze'), masterToken, {})).body.mapping.tables) as any[])[0];
  assert.equal(csvTable.entity, 'CUSTOMER');
  assert.equal((await call('PUT', cp('/mapping'), masterToken, { tables: { [csvTable.key]: { approved: true } } })).status, 200);
  assert.equal((await call('POST', cp('/preview'), masterToken, {})).status, 200);
  assert.equal((await call('POST', cp('/approve'), masterToken, { confirm: 'EXECUTAR' })).status, 200);
  const csvRow = await prisma.migrationSession.findUniqueOrThrow({ where: { id: csvSession } });
  let handled = 0;
  const stopped = await runMigration(csvRow, { id: master.id, label: 'Operador RM' }, { batchSize: 2, hooks: { beforeRecord: async () => { if (++handled === 3) assert.equal((await call('POST', cp('/cancel'), masterToken, {})).body.pending, true); } } });
  assert.equal(stopped.status, 'CANCELLED');
  const afterCancel = await prisma.migrationSession.findUniqueOrThrow({ where: { id: csvSession } });
  assert.equal(afterCancel.status, 'CANCELLED'); assert.equal(afterCancel.cancelRequested, false);
  assert.equal(await prisma.customer.count({ where: { tenantId: tenantB.id, name: { startsWith: 'Cliente' } } }), 3, 'exactly the records handled before the stop were written');
  assert.equal((await call('POST', cp('/execute'), masterToken, {})).status, 409, 'a cancelled migration cannot be resumed');

  // ---- One execution at a time per restaurant ----
  const first = await prisma.migrationSession.create({ data: { tenantId: tenantA.id, label: 'em execução', engineVersion: '1', status: 'RUNNING' } });
  await assert.rejects(prisma.migrationSession.create({ data: { tenantId: tenantA.id, label: 'segunda', engineVersion: '1', status: 'RUNNING' } }), /Unique constraint/);
  await prisma.migrationSession.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
  const second = await prisma.migrationSession.create({ data: { tenantId: tenantA.id, label: 'outra', engineVersion: '1', status: 'RUNNING' } });
  assert.equal(second.status, 'RUNNING');
});
