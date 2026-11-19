import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { RunInterrupted, runMigration } from '../lib/migration/executor';
import { bigPayablesCsv, LEGACY_FINANCE_DUMP } from '../lib/migration/legacy-finance.fixture';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

test('RM Smart Migration (cadastral + financial scope): import, review, backup gate, resume, integration with the financial module, isolation, selective rollback and large files', { skip: !enabled, timeout: 240_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
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
  const backupDir = await mkdtemp(join(tmpdir(), 'rmbk-fin-'));
  const mkTenant = (label: string) => prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label.toLowerCase().replace(/\W/g, '-')}-${id}`, status: 'ACTIVE' } });
  const [tenantA, tenantB, tenantC] = [await mkTenant('Fin A'), await mkTenant('Fin B'), await mkTenant('Fin C')];
  const adminA = await prisma.user.create({ data: { tenantId: tenantA.id, name: 'Admin A', email: `a-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const master = await prisma.user.create({ data: { name: 'Operador RM', email: `m-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const tenantToken = signAccessToken({ userId: adminA.id, tenantId: tenantA.id, unitId: null, role: UserRole.ADMIN });
  t.after(async () => {
    delete process.env.MIGRATION_REQUIRE_BACKUP; delete process.env.MIGRATION_BACKUP_DIR; delete process.env.MIGRATION_BACKUP_ENCRYPTION_KEY;
    await rm(backupDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: [master.id, adminA.id] } } });
    await prisma.migrationMappingTemplate.deleteMany({ where: { createdById: master.id } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id, tenantC.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [master.id, adminA.id] } } });
    await prisma.$disconnect();
  });

  // Another restaurant with look-alike data that must never be touched or linked.
  const supplierB = await prisma.supplier.create({ data: { tenantId: tenantB.id, name: 'Distribuidora Alfa Ltda', document: '11222333000181' } });
  await prisma.financialEntry.create({ data: { tenantId: tenantB.id, type: 'EXPENSE', description: 'Compra bebidas NF 1001', amount: 1000, supplierId: supplierB.id, documentNumber: 'NF-1001', installmentNumber: 1 } });
  const snapshotB = async () => ({ suppliers: await prisma.supplier.count({ where: { tenantId: tenantB.id } }), entries: await prisma.financialEntry.findMany({ where: { tenantId: tenantB.id }, select: { amount: true, status: true, supplierId: true } }), categories: await prisma.financialCategory.count({ where: { tenantId: tenantB.id } }), banks: await prisma.bankAccount.count({ where: { tenantId: tenantB.id } }) });
  const beforeB = await snapshotB();
  // Pre-existing data of the target restaurant that the migration must respect.
  await prisma.financialCategory.create({ data: { tenantId: tenantA.id, type: 'EXPENSE', name: 'aluguel' } });
  const existingEntry = await prisma.financialEntry.create({ data: { tenantId: tenantA.id, type: 'INCOME', description: 'Fiado Ana', amount: 50, dueAt: new Date('2024-02-15T12:00:00Z'), documentNumber: 'F-1', installmentNumber: 1, debtorName: 'Ana Souza' } });

  const created = await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, masterToken, { label: 'Legado XPTO', sourceUnknown: true });
  assert.equal(created.status, 201);
  const sid = created.body.id as string; const path = (suffixPath = '', tenant = tenantA.id) => `/migrations/tenants/${tenant}/sessions/${sid}${suffixPath}`;
  const capabilities = (await call('GET', '/migrations/capabilities', masterToken)).body;
  assert.deepEqual(capabilities.groups.map((group: any) => group.label), ['Produtos e estoque', 'Clientes', 'Fornecedores', 'Contas a pagar', 'Contas a receber', 'Estrutura financeira', 'Funcionários (cadastro)', 'Histórico de vendas']);
  assert.ok(capabilities.unsupportedModules.some((item: string) => /Mesas e comandas/.test(item)) && !capabilities.unsupportedModules.some((item: string) => /financeiro/i.test(item)));

  // ---- Upload, analysis, mapping ----
  assert.equal((await call('POST', path('/files?name=legado.sql'), masterToken, undefined, Buffer.from(LEGACY_FINANCE_DUMP))).status, 201);
  const analysis = await call('POST', path('/analyze'), masterToken, {});
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  const tables = Object.values(analysis.body.mapping.tables) as any[];
  assert.deepEqual(tables.map(table => table.entity).sort(), ['BANK_ACCOUNT', 'COST_CENTER', 'CUSTOMER', 'FIN_CATEGORY', 'PAYABLE', 'PRODUCT', 'RECEIVABLE', 'SUPPLIER']);
  assert.equal((await call('PUT', path('/mapping'), masterToken, { tables: Object.fromEntries(tables.map(table => [table.key, { approved: true }])) })).status, 200);

  // ---- Preview: counts, relationships, financial totals, opening balances ----
  const preview = (await call('POST', path('/preview'), masterToken, {})).body.summary;
  assert.equal(preview.byEntity.PAYABLE.total, 11); assert.equal(preview.byEntity.RECEIVABLE.total, 3);
  assert.equal(preview.byEntity.PAYABLE.REJECTED, 2); assert.equal(preview.byEntity.PAYABLE.DUPLICATE, 1);
  assert.equal(preview.byEntity.RECEIVABLE.DUPLICATE, 1, 'the first receivable already exists in the restaurant');
  assert.equal(preview.refs['PAYABLE.supplierRef'].unresolved, 1); assert.equal(preview.refs['PRODUCT.supplierRef'].resolved, 2);
  assert.equal(preview.financial.initialBalances.accounts, 2); assert.equal(preview.financial.initialBalances.total, '10249.50');
  assert.ok(preview.financial.payable.count > 0 && preview.financial.receivable.count > 0);
  const recordsOf = async (query: string) => (await call('GET', path(`/records?${query}`), masterToken)).body.items as any[];

  // ---- Human review of the held-back records ----
  const noDate = (await recordsOf('entity=PAYABLE&status=REJECTED')).find(record => record.original.descricao === 'Pago sem data');
  assert.ok(noDate.issues.some((issue: any) => issue.code === 'paid_without_date'));
  const fixedDate = await call('PATCH', path(`/records/${noDate.id}`), masterToken, { values: { settledAt: '01/03/2024' } });
  assert.equal(fixedDate.body.status, 'VALID'); assert.equal(fixedDate.body.normalized.settledAt, '2024-03-01'); assert.ok(fixedDate.body.corrections.some((correction: any) => correction.rule === 'manual'));
  const badValue = (await recordsOf('entity=PAYABLE&status=REJECTED')).find(record => record.original.descricao === 'Valor inválido');
  assert.equal((await call('PATCH', path(`/records/${badValue.id}`), masterToken, { ignore: true })).status, 200);
  const divergent = await recordsOf('entity=PAYABLE&status=DIVERGENT');
  assert.deepEqual(divergent.map(record => record.original.descricao).sort(), ['Data inválida', 'Fornecedor desconhecido', 'Quitado sem valor']);
  for (const record of divergent) {
    if (record.original.descricao === 'Data inválida') assert.equal((await call('PATCH', path(`/records/${record.id}`), masterToken, { values: { dueAt: '10/03/2024' } })).body.status, 'VALID');
    else assert.equal((await call('PATCH', path(`/records/${record.id}`), masterToken, { approve: true })).status, 200);
  }
  assert.equal((await call('POST', path('/bulk-approve'), masterToken, {})).status, 200);
  const stillDivergent = await recordsOf('status=DIVERGENT');
  assert.deepEqual(stillDivergent.map(record => record.approved), [true, true], 'the two divergences left were explicitly approved by the operator');

  // ---- Backup gate (mandatory in production): only a platform-generated, restore-tested backup of THIS restaurant releases the authorization ----
  process.env.MIGRATION_REQUIRE_BACKUP = 'true';
  process.env.MIGRATION_BACKUP_DIR = backupDir;
  process.env.MIGRATION_BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  assert.equal((await call('GET', '/migrations/capabilities', masterToken)).body.backupRequired, true);
  assert.equal((await call('POST', path('/approve'), masterToken, { confirm: 'EXECUTAR' })).status, 422, 'no backup');
  assert.equal((await call('POST', path('/approve'), masterToken, { confirm: 'EXECUTAR', backup: { confirmed: true, reference: 'neon-branch pre-migracao-legado' } })).status, 422, 'an operator statement is not proof of recoverability');
  const backup = await call('POST', path('/backups'), masterToken);
  assert.equal(backup.status, 201, JSON.stringify(backup.body)); assert.equal(backup.body.status, 'VERIFIED');
  assert.equal((await call('POST', path('/approve'), masterToken, { confirm: 'EXECUTAR' })).status, 200);
  delete process.env.MIGRATION_REQUIRE_BACKUP;
  const backupReference = (await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } })).backupReference;
  assert.match(backupReference ?? '', new RegExp(`^rmbk:${backup.body.id} sha256:`));

  // ---- Interruption in the middle of the financial import, then safe resume ----
  const session = await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } });
  let seen = 0;
  const interrupted = await runMigration(session, { id: master.id, label: 'Operador RM' }, { batchSize: 7, hooks: { beforeRecord: () => { if (++seen === 21) throw new RunInterrupted('queda simulada'); } } });
  assert.equal(interrupted.status, 'INTERRUPTED');
  const resumed = await call('POST', path('/resume'), masterToken, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.status, 'COMPLETED');
  assert.equal(resumed.body.outcome, 'VALIDATED', 'every divergence was decided by the operator and all post-migration checks pass');

  // ---- Result in the restaurant database ----
  const suppliers = await prisma.supplier.findMany({ where: { tenantId: tenantA.id } });
  assert.deepEqual(suppliers.map(supplier => supplier.name).sort(), ['Distribuidora Alfa Ltda', 'Hortifruti Beta ME']);
  const alfa = suppliers.find(supplier => supplier.name.startsWith('Distribuidora'))!;
  assert.deepEqual([alfa.tradeName, alfa.document, alfa.stateRegistration, alfa.zip, alfa.state, alfa.contactName, alfa.email], ['Alfa Bebidas', '11222333000181', '123.456.789', '01310100', 'SP', 'Carlos', 'vendas@alfa.com']);
  const customers = await prisma.customer.findMany({ where: { tenantId: tenantA.id } });
  assert.deepEqual(customers.map(customer => customer.name).sort(), ['Ana Souza', 'Bruno Lima', 'Empresa Gama']);
  const ana = customers.find(customer => customer.name === 'Ana Souza')!;
  assert.deepEqual([ana.phone, ana.whatsapp, ana.zip, ana.city, ana.state, ana.marketingConsent], ['11912345678', '11912345678', '01310100', 'São Paulo', 'SP', false]);
  assert.deepEqual((await prisma.costCenter.findMany({ where: { tenantId: tenantA.id }, select: { name: true } })).map(center => center.name).sort(), ['Cozinha', 'Salão']);
  const banks = await prisma.bankAccount.findMany({ where: { tenantId: tenantA.id } });
  assert.equal(banks.find(bank => bank.name === 'Poupança Reserva')!.initialBalance.toString(), '-250.5'); assert.equal(banks.find(bank => bank.name === 'Caixa Itaú')!.initialBalanceAt?.toISOString().slice(0, 10), '2024-01-01');
  const finCategories = await prisma.financialCategory.findMany({ where: { tenantId: tenantA.id }, include: { parent: true } });
  assert.equal(finCategories.length, 4, 'the lowercase "aluguel" already existed: no duplicate'); assert.equal(finCategories.find(category => category.name === 'Bebidas')!.parent?.name, 'Insumos'); assert.equal(finCategories.find(category => category.name === 'Vendas Salão')!.type, 'INCOME');
  const productCategories = await prisma.productCategory.findMany({ where: { tenantId: tenantA.id }, include: { parent: true } });
  assert.equal(productCategories.find(category => category.name === 'Cervejas')!.parent?.name, 'Bebidas');
  const beer = await prisma.product.findFirstOrThrow({ where: { tenantId: tenantA.id, name: 'Cerveja Lata 350ml' }, include: { category: true, supplier: true, stockMovements: true } });
  assert.deepEqual([beer.category?.name, beer.supplier?.name, beer.cost?.toString(), beer.stockQuantity.toString(), beer.stockMin?.toString()], ['Cervejas', 'Distribuidora Alfa Ltda', '3.2', '120', '24']);
  assert.equal(beer.stockMovements.length, 1); assert.match(beer.stockMovements[0].note ?? '', /Abertura de estoque/);

  const entries = await prisma.financialEntry.findMany({ where: { tenantId: tenantA.id }, include: { supplier: true, customer: true, costCenter: true, bankAccount: true } });
  const find = (description: string, installment?: number) => entries.find(entry => entry.description === description && (installment === undefined || entry.installmentNumber === installment))!;
  const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
  const first = find('Compra bebidas NF 1001', 1);
  assert.deepEqual([first.status, first.paidAmount.toString(), day(first.settledAt), day(first.dueAt), day(first.issuedAt), first.documentNumber, first.installmentCount, first.supplier?.name, first.costCenter?.name, first.bankAccount?.name, first.paymentMethod, first.category], ['PAID', '1000', '2024-02-09', '2024-02-10', '2024-01-10', 'NF-1001', 3, 'Distribuidora Alfa Ltda', 'Cozinha', 'Caixa Itaú', 'Boleto', 'Bebidas'], 'historical dates and links preserved');
  const partial = find('Compra bebidas NF 1001', 2);
  assert.deepEqual([partial.status, partial.paidAmount.toString(), partial.settledAt, partial.amount.toString()], ['OPEN', '400', null, '1000']); assert.match(partial.notes ?? '', /Último pagamento parcial/);
  assert.deepEqual([find('Compra bebidas NF 1001', 3).status, find('Compra bebidas NF 1001', 3).paidAmount.toString()], ['OPEN', '0']);
  const rent = find('Aluguel janeiro');
  assert.deepEqual([rent.status, rent.amount.toString(), rent.interestAmount.toString(), rent.paidAmount.toString(), rent.category, entries.filter(entry => entry.description === 'Aluguel janeiro').length], ['PAID', '5000', '100', '5100', 'aluguel', 1], 'identical repeated row not duplicated');
  assert.equal(find('Compra cancelada').status, 'CANCELLED');
  assert.equal(find('Quitado sem valor').paidAmount.toString(), '250');
  const orphan = find('Fornecedor desconhecido'); assert.equal(orphan.supplierId, null);
  assert.equal(find('Pago sem data').settledAt?.toISOString().slice(0, 10), '2024-03-01'); assert.equal(day(find('Data inválida').dueAt), '2024-03-10');
  assert.equal(entries.some(entry => entry.description === 'Valor inválido'), false, 'ignored by the operator');
  const receivables = entries.filter(entry => entry.type === 'INCOME');
  assert.equal(receivables.length, 3, 'pre-existing "Fiado Ana 1/2" + the second instalment + the event');
  assert.equal(receivables.filter(entry => entry.description === 'Fiado Ana').length, 2);
  assert.equal(find('Fiado Ana', 2).customer?.name, 'Ana Souza'); assert.equal(find('Evento Gama').customer?.name, 'Empresa Gama');
  assert.deepEqual(await snapshotB(), beforeB, 'another restaurant is never altered');
  assert.ok(entries.every(entry => entry.supplier === null || entry.supplier.tenantId === tenantA.id));

  // ---- The imported entries show up in the restaurant's own financial module ----
  const listing = await call('GET', '/financial/entries?pageSize=100', tenantToken);
  assert.equal(listing.status, 200); assert.equal(listing.body.total, entries.length);
  const listed = listing.body.items.find((entry: any) => entry.description === 'Compra bebidas NF 1001' && entry.installmentNumber === 1);
  assert.deepEqual([listed.supplier.name, listed.costCenter.name, listed.bankAccount.name, listed.status], ['Distribuidora Alfa Ltda', 'Cozinha', 'Caixa Itaú', 'PAID']);
  assert.equal((await call('GET', '/financial/bank-accounts', tenantToken)).body.items.length, 2); assert.equal((await call('GET', '/financial/cost-centers', tenantToken)).body.items.length, 2);
  const summary = (await call('GET', '/financial/summary', tenantToken)).body;
  assert.ok(Number(summary.openPayables) > 0, 'open instalments count as accounts payable'); assert.ok(Number(summary.expenses) > 0);
  assert.equal((await call('GET', '/migrations/capabilities', tenantToken)).status, 403);

  // ---- Report: groups, financial totals, CSV and PDF ----
  const report = (await call('GET', path('/report'), masterToken)).body;
  assert.equal(report.groups.find((group: any) => group.key === 'payables').imported, 9, '11 rows - 1 repeated - 1 ignored by the operator'); assert.equal(report.groups.find((group: any) => group.key === 'finance').imported, 7, '3 new financial categories (aluguel existed) + 2 cost centres + 2 bank accounts');
  assert.equal(report.financial.initialBalances.accounts, 2); assert.equal(report.financial.receivable.count, 2);
  assert.ok(report.integrity.some((check: any) => /Datas históricas/.test(check.name) && check.ok) && report.integrity.every((check: any) => check.ok));
  assert.equal(report.identification.backupReference, backupReference);
  const csv = await call('GET', path('/report.csv'), masterToken); assert.match(csv.text, /Contas a pagar;PAYABLE/); assert.match(csv.text, /Contas a receber;RECEIVABLE/); assert.match(csv.text, /paid_assumed_full/);
  assert.ok((await call('GET', path('/report.pdf'), masterToken)).text.startsWith('%PDF'));

  // ---- Selective rollback: nothing built on top of the migration may be compromised ----
  const settledLater = find('Compra bebidas NF 1001', 3);
  assert.equal((await call('POST', `/financial/entries/${settledLater.id}/settle`, tenantToken)).status, 200, 'the restaurant settles an imported instalment after the migration');
  const rollback = await call('POST', path('/rollback'), masterToken, { confirm: 'REVERTER' });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
  const reasons = rollback.body.blocked.map((item: any) => item.reason).join(' | ');
  assert.match(reasons, /Lançamento alterado ou baixado/); assert.match(reasons, /Fornecedor ainda vinculado/); assert.match(reasons, /Categoria financeira ainda utilizada/); assert.match(reasons, /Conta bancária ainda vinculada/); assert.match(reasons, /Centro de custo ainda vinculado/);
  const afterEntries = await prisma.financialEntry.findMany({ where: { tenantId: tenantA.id }, select: { id: true, description: true } });
  assert.ok(afterEntries.some(entry => entry.id === settledLater.id), 'the entry settled afterwards survives');
  assert.ok(afterEntries.some(entry => entry.id === existingEntry.id), 'pre-existing data survives');
  assert.equal(afterEntries.length, 2, 'only the pre-existing entry and the one settled afterwards remain: everything else was reverted');
  assert.equal(await prisma.customer.count({ where: { tenantId: tenantA.id } }), 0, 'customers without later use are removed');
  assert.equal(await prisma.product.count({ where: { tenantId: tenantA.id } }), 0);
  assert.equal(await prisma.supplier.count({ where: { tenantId: tenantA.id } }), 1, 'the supplier still used by the settled entry stays');
  assert.deepEqual(await snapshotB(), beforeB);
  assert.equal((await prisma.migrationSession.findUniqueOrThrow({ where: { id: sid } })).status, 'COMPLETED', 'partial rollback keeps the session open');

  // ---- Large file: processed in the background, in batches, without duplicates ----
  await prisma.supplier.create({ data: { tenantId: tenantC.id, name: 'Fornecedor Grande' } });
  const big = (await call('POST', `/migrations/tenants/${tenantC.id}/sessions`, masterToken, { label: 'Grande', sourceSystem: 'Planilha' })).body.id as string;
  const bp = (suffixPath: string) => `/migrations/tenants/${tenantC.id}/sessions/${big}${suffixPath}`;
  assert.equal((await call('POST', bp('/files?name=contas_pagar_grande.csv'), masterToken, undefined, Buffer.from(bigPayablesCsv(2100, 'Fornecedor Grande')))).status, 201);
  const bigTable = (Object.values((await call('POST', bp('/analyze'), masterToken, {})).body.mapping.tables) as any[])[0];
  assert.equal(bigTable.entity, 'PAYABLE');
  assert.equal((await call('PUT', bp('/mapping'), masterToken, { tables: { [bigTable.key]: { approved: true } } })).status, 200);
  const bigPreview = (await call('POST', bp('/preview'), masterToken, {})).body.summary;
  assert.equal(bigPreview.importable, 2100); assert.equal(bigPreview.estimate.batches, 11);
  assert.equal((await call('POST', bp('/approve'), masterToken, { confirm: 'EXECUTAR' })).status, 200);
  const started = await call('POST', bp('/execute'), masterToken, {});
  assert.equal(started.status, 202, 'large volumes run in the background');
  assert.equal((await call('POST', bp('/execute'), masterToken, {})).status, 409, 'no second run while one is active');
  let finished: any;
  for (let attempt = 0; attempt < 150; attempt++) { finished = (await call('GET', bp(''), masterToken)).body; if (finished.status === 'COMPLETED') break; await new Promise(resolve => setTimeout(resolve, 1000)); }
  assert.equal(finished.status, 'COMPLETED'); assert.equal(finished.outcome, 'VALIDATED');
  assert.equal(await prisma.financialEntry.count({ where: { tenantId: tenantC.id } }), 2100);
  assert.equal(await prisma.financialEntry.count({ where: { tenantId: tenantC.id, supplier: { name: 'Fornecedor Grande' } } }), 2100, 'every entry linked to the existing supplier by name');
  assert.ok((await call('GET', bp('/events'), masterToken)).body.items.filter((event: any) => event.type === 'BATCH_DONE').length >= 10, 'processed in batches');
});
