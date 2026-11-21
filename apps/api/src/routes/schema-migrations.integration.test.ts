import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// Real schema-migration audit on throw-away PostgreSQL databases (RUN_DB_TESTS=1, role allowed to CREATE DATABASE). Never touches the database named by
// DATABASE_URL except to create/drop the temporary ones next to it. All data is fictitious.
const enabled = process.env.RUN_DB_TESTS === '1';
const dbPackage = join(__dirname, '../../../../packages/db');
const apiRoot = join(__dirname, '../..');
const allMigrations = readdirSync(join(dbPackage, 'prisma/migrations')).filter(name => /^\d{14}_/.test(name)).sort();
const BEFORE_SMART = '20261119000000_user_appearance';
const SMART = '20261119120000_smart_migration';
const TEF_CORE = '20261120180000_tef_core';
const SUPER_AI = '20261120200000_super_ai';
const PRINT_DEDUP = '20261121100000_print_dedup';
const MIGRATION_UNIT = '20261121110000_migration_unit';
const CRM_LOYALTY = '20261121120000_crm_loyalty';
const STOCK_INTELLIGENCE = '20261121130000_stock_intelligence';
const SERVICE_FLOW = '20261121140000_service_flow';
const AUTOMATIONS = '20261121150000_automations';
const COMMISSION_RULES = '20261121160000_commission_rules';
const UNIT_PRICES = '20261121170000_unit_prices';
const RECON_CLOSINGS = '20261121180000_reconciliation_closings';
const KDS_STAGES = '20261121190000_kds_stages';
const MODULE_NETWORK = '20261122000000_module_network';
const WHATSAPP_DB_AUTH = '20261122010000_whatsapp_db_auth_ai_config';
const WORKER_HEARTBEAT = '20261122020000_worker_heartbeat';
const NEW_FOUR = ['20261119120000_smart_migration', '20261119180000_migration_finance_scope', '20261119230000_pricing_costs', '20261120120000_migration_backup'];
const id = randomBytes(4).toString('hex');
const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function urlFor(base: string, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function cli(args: string[], databaseUrl: string, schema?: string) {
  const result = spawnSync('npx', ['--no-install', 'prisma', ...args, ...(schema ? ['--schema', schema] : [])], { cwd: dbPackage, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}
// A prisma directory holding the real schema and a chosen subset of the real migrations (optionally with replaced SQL / extra migrations).
function stage(names: string[], overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rm-mig-'));
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  cpSync(join(dbPackage, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
  cpSync(join(dbPackage, 'prisma/migrations/migration_lock.toml'), join(dir, 'migrations/migration_lock.toml'));
  for (const name of names) { cpSync(join(dbPackage, 'prisma/migrations', name), join(dir, 'migrations', name), { recursive: true }); }
  for (const [name, sql] of Object.entries(overrides)) { mkdirSync(join(dir, 'migrations', name), { recursive: true }); writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql); }
  return { dir, schema: join(dir, 'schema.prisma') };
}
const upTo = (last: string) => allMigrations.filter(name => name <= last);

type Snapshot = Record<string, Map<string, Record<string, unknown>>>;
async function snapshot(client: PrismaClient): Promise<Snapshot> {
  const tables = (await client.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`)).map(row => row.table_name);
  const keys = await client.$queryRawUnsafe<{ table_name: string; columns: string[] }[]>(`SELECT c.relname AS table_name, array_agg(a.attname ORDER BY k.ord) AS columns FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary GROUP BY c.relname`);
  const pk = new Map(keys.map(row => [row.table_name, row.columns]));
  const result: Snapshot = {};
  for (const table of tables) {
    const rows = await client.$queryRawUnsafe<{ j: Record<string, unknown> }[]>(`SELECT to_jsonb(t) AS j FROM ${q(table)} t`);
    result[table] = new Map(rows.map(({ j }) => [pk.get(table)?.map(column => String(j[column])).join('|') ?? JSON.stringify(j), j]));
  }
  return result;
}
// Every row that existed before must still exist, with every previous column holding the same value (numbers compared by value).
function compareSnapshots(before: Snapshot, after: Snapshot) {
  const problems: string[] = []; let rows = 0; let cells = 0; const added: Record<string, number> = {};
  for (const [table, map] of Object.entries(before)) {
    const next = after[table];
    if (!next) { problems.push(`table ${table} disappeared`); continue; }
    for (const [key, row] of map) {
      const current = next.get(key); rows += 1;
      if (!current) { problems.push(`${table}[${key}] lost`); continue; }
      for (const [column, value] of Object.entries(row)) {
        cells += 1;
        if (!(column in current)) { problems.push(`${table}[${key}].${column} column lost`); continue; }
        if (JSON.stringify(current[column]) !== JSON.stringify(value)) problems.push(`${table}[${key}].${column}: ${JSON.stringify(value)} -> ${JSON.stringify(current[column])}`);
      }
    }
    if (next.size > map.size) added[table] = next.size - map.size;
  }
  for (const [table, map] of Object.entries(after)) if (!before[table] && map.size) added[table] = map.size;
  return { problems, rows, cells, added };
}

async function aggregates(client: PrismaClient) {
  const one = async (sql: string) => JSON.parse(JSON.stringify(await client.$queryRawUnsafe(sql), (_k, value) => typeof value === 'bigint' ? Number(value) : value));
  return {
    financial: await one(`SELECT "tenantId", count(*)::int AS n, sum(amount)::text AS amount, sum(coalesce("paidAmount",0))::text AS paid, count(*) FILTER (WHERE type='EXPENSE')::int AS payable, count(*) FILTER (WHERE type='INCOME')::int AS receivable, count(*) FILTER (WHERE status='PAID')::int AS settled FROM "FinancialEntry" GROUP BY 1 ORDER BY 1`),
    products: await one(`SELECT "tenantId", count(*)::int AS n, sum(price)::text AS price, sum(coalesce(cost,0))::text AS cost FROM "Product" GROUP BY 1 ORDER BY 1`),
    orders: await one(`SELECT o."tenantId", count(DISTINCT o.id)::int AS n, sum(DISTINCT o.total)::text AS distinct_total, count(i.id)::int AS items, sum(i.total)::text AS item_total, sum(i.quantity)::text AS qty FROM "Order" o LEFT JOIN "OrderItem" i ON i."orderId" = o.id GROUP BY 1 ORDER BY 1`),
    payments: await one(`SELECT "tenantId", count(*)::int AS n, sum(amount)::text AS amount FROM "Payment" GROUP BY 1 ORDER BY 1`),
    people: await one(`SELECT "tenantId", (SELECT count(*) FROM "Customer" c WHERE c."tenantId" = t."tenantId")::int AS customers, (SELECT count(*) FROM "Supplier" s WHERE s."tenantId" = t."tenantId")::int AS suppliers, (SELECT count(*) FROM "User" u WHERE u."tenantId" = t."tenantId")::int AS users FROM (SELECT DISTINCT "tenantId" FROM "Product") t ORDER BY 1`),
  };
}
const numeric = (value: unknown) => Number(value).toFixed(3);
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalise(inner)]));
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? numeric(value) : value;
}

test('schema migrations: ordering, clean database, upgrade with legacy data, financial integrity, tenant isolation, interruption and recovery', { skip: !enabled, timeout: 900_000 }, async t => {
  const base = process.env.DATABASE_URL!;
  const admin = new PrismaClient({ datasources: { db: { url: urlFor(base, 'postgres') } } });
  const created: string[] = []; const dirs: string[] = [];
  const clients: PrismaClient[] = [];
  const newDb = async (label: string) => { const name = `rm_${label}_${id}`; await admin.$executeRawUnsafe(`CREATE DATABASE ${q(name)}`); created.push(name); const url = urlFor(base, name); const client = new PrismaClient({ datasources: { db: { url } } }); clients.push(client); return { name, url, client }; };
  t.after(async () => {
    for (const client of clients) await client.$disconnect().catch(() => undefined);
    for (const name of created) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const staged = (...args: Parameters<typeof stage>) => { const result = stage(...args); dirs.push(result.dir); return result; };
  const deploy = (url: string, schema: string) => cli(['migrate', 'deploy'], url, schema);

  await t.test('static audit: sequence, lock file, no destructive statements beyond the two documented index swaps and one safe widening', async () => {
    assert.deepEqual([...allMigrations], [...allMigrations].sort(), 'chronological order');
    assert.equal(new Set(allMigrations.map(name => name.slice(0, 14))).size, allMigrations.length, 'no duplicate timestamps');
    for (const name of NEW_FOUR) assert.ok(allMigrations.includes(name), name);
    assert.deepEqual(allMigrations.slice(allMigrations.indexOf(NEW_FOUR[0])), [...NEW_FOUR.slice(0, 3), '20261120120000_migration_backup', TEF_CORE, SUPER_AI, PRINT_DEDUP, MIGRATION_UNIT, CRM_LOYALTY, STOCK_INTELLIGENCE, SERVICE_FLOW, AUTOMATIONS, COMMISSION_RULES, UNIT_PRICES, RECON_CLOSINGS, KDS_STAGES, MODULE_NETWORK, WHATSAPP_DB_AUTH, WORKER_HEARTBEAT], 'audited migrations, then the TEF core, the AI tables, the print dedup, the migration unit, the loyalty ledger, the stock intelligence and the service flow, in this order');
    const sqlOf = (name: string) => spawnSync('cat', [join(dbPackage, 'prisma/migrations', name, 'migration.sql')], { encoding: 'utf8' }).stdout;
    const destructive: string[] = [];
    for (const name of allMigrations) for (const line of sqlOf(name).split('\n')) if (/\b(DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)|TRUNCATE|DELETE\s+FROM|RENAME\b|CREATE\s+EXTENSION)/i.test(line) || /^\s*DROP\s+INDEX/i.test(line) || /ALTER\s+COLUMN/i.test(line)) destructive.push(`${name}: ${line.trim()}`);
    assert.deepEqual(destructive, [
      '20261117172000_fractional_product_quantities: ALTER COLUMN "quantity" TYPE DECIMAL(12,3)',
      '20261117210000_fiscal_module: DROP INDEX "FiscalNumbering_tenantId_kind_key";',
      '20261117220000_fiscal_certificates_cfop: DROP INDEX "FiscalNumbering_tenantId_kind_environment_key";',
    ], 'only: integer→decimal(12,3) widening (lossless), and two unique-index replacements on FiscalNumbering (re-created in the same migration; no row is touched)');
    for (const name of NEW_FOUR) assert.doesNotMatch(sqlOf(name), /\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|^\s*UPDATE\b|\bALTER\s+COLUMN\b/im, `${name} must be purely additive`);
    for (const name of allMigrations) assert.doesNotMatch(sqlOf(name), /CONCURRENTLY|CREATE\s+EXTENSION|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)/i, `${name}: Neon-incompatible or privileged construct`);
  });

  await t.test('A — clean database: every migration applies in order, nothing is pending, the schema equals the Prisma schema, deploy is idempotent', async () => {
    const db = await newDb('clean'); const full = staged(allMigrations);
    const first = deploy(db.url, full.schema); assert.equal(first.status, 0, first.out);
    assert.equal((first.out.match(/^\s+└─ \d{14}_/gm) ?? []).length, allMigrations.length, 'all migrations reported as applied');
    const applied = await db.client.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at, migration_name`);
    assert.deepEqual(applied.map(row => row.migration_name), allMigrations); assert.ok(applied.every(row => row.finished_at && !row.rolled_back_at));
    const second = deploy(db.url, full.schema); assert.equal(second.status, 0, second.out); assert.match(second.out, /No pending migrations/);
    const status = cli(['migrate', 'status'], db.url, full.schema); assert.equal(status.status, 0, status.out); assert.match(status.out, /Database schema is up to date/);
    const drift = cli(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', join(dbPackage, 'prisma/schema.prisma'), '--exit-code'], db.url);
    assert.equal(drift.status, 0, `schema drift between migrations and schema.prisma:\n${drift.out}`);
    // Structural invariants Prisma cannot express are present, and every constraint is validated.
    const partial = (await db.client.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE '%WHERE%'`)).map(row => row.indexname);
    for (const name of ['MigrationSession_tenantId_running_key', 'SaaSInvoice_tenantId_reference_open_key']) assert.ok(partial.includes(name), `partial unique index ${name}`);
    assert.equal((await db.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_constraint WHERE NOT convalidated`))[0].n, 0, 'no NOT VALID constraints');
    // Tenant-owned tables of the Smart Migration / pricing / finance scope: FK to Tenant with cascade, and an index that starts with tenantId.
    const scope = ['MigrationSession', 'MigrationFile', 'MigrationRecord', 'MigrationEvent', 'MigrationBackup', 'ProductPricing', 'PriceHistory', 'CostCenter', 'BankAccount', 'FinancialEntry', 'FinancialCategory', 'Supplier', 'Customer', 'Product', 'ProductCategory'];
    const tenantFk = await db.client.$queryRawUnsafe<{ t: string; del: string }[]>(`SELECT cl.relname AS t, c.confdeltype::text AS del FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class rf ON rf.oid = c.confrelid WHERE c.contype='f' AND rf.relname='Tenant' AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY ("tenantId")%'`);
    const indexed = (await db.client.$queryRawUnsafe<{ t: string }[]>(`SELECT DISTINCT tablename AS t FROM pg_indexes WHERE schemaname='public' AND indexdef ~ '\\("tenantId"'`)).map(row => row.t);
    for (const table of scope) {
      assert.ok(tenantFk.some(row => row.t === table && row.del === 'c'), `${table}.tenantId → Tenant ON DELETE CASCADE`);
    }
    t.diagnostic(`scope tables without a tenantId-leading index (cascade deletes scan them): ${scope.filter(table => !indexed.includes(table)).join(', ') || 'none'}`);
    const noTenantColumn = await db.client.$queryRawUnsafe<{ t: string }[]>(`SELECT c.table_name AS t FROM information_schema.columns c WHERE c.table_schema='public' AND c.column_name='tenantId' AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class cl ON cl.oid=k.conrelid WHERE k.contype='f' AND cl.relname=c.table_name AND pg_get_constraintdef(k.oid) LIKE 'FOREIGN KEY ("tenantId")%')`);
    t.diagnostic(`tables with a tenantId column but no foreign key to Tenant: ${noTenantColumn.map(row => row.t).join(', ') || 'none'}`);
    assert.deepEqual(noTenantColumn.filter(row => scope.includes(row.t)), []);
    // Prisma client round trip against the freshly built schema (every new model is usable).
    const tenant = await db.client.tenant.create({ data: { name: 'Clean', slug: `clean-${id}`, status: 'ACTIVE' } });
    const product = await db.client.product.create({ data: { tenantId: tenant.id, name: 'P', price: 10, cost: 4 } });
    await db.client.productPricing.create({ data: { tenantId: tenant.id, productId: product.id, marginPercent: 30 } });
    await db.client.priceHistory.create({ data: { tenantId: tenant.id, productId: product.id, price: 10, cost: 4, reason: 'teste' } });
    const session = await db.client.migrationSession.create({ data: { tenantId: tenant.id, label: 's', engineVersion: 't' } });
    await db.client.migrationBackup.create({ data: { tenantId: tenant.id, sessionId: session.id, database: {}, engineVersion: 't' } });
    await db.client.tenant.delete({ where: { id: tenant.id } });
    for (const table of ['Product', 'ProductPricing', 'PriceHistory', 'MigrationSession', 'MigrationBackup']) assert.equal((await db.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(table)}`))[0].n, 0, `${table} cascades with the tenant`);
    // Only one RUNNING session per tenant (partial unique index) and unique pricing per product.
    const tenant2 = await db.client.tenant.create({ data: { name: 'Clean2', slug: `clean2-${id}`, status: 'ACTIVE' } });
    await db.client.migrationSession.create({ data: { tenantId: tenant2.id, label: 'a', engineVersion: 't', status: 'RUNNING' } });
    await assert.rejects(db.client.migrationSession.create({ data: { tenantId: tenant2.id, label: 'b', engineVersion: 't', status: 'RUNNING' } }), /Unique constraint/);
    t.diagnostic(`A: ${allMigrations.length} migrations applied on an empty database; schema drift: none; partial indexes: ${partial.length}`);
  });

  // ---- Legacy fictitious data, written with raw SQL at the schema of each historical stage ----
  const tenants = { a: `ten-a-${id}`, b: `ten-b-${id}` };
  const seedInit = async (client: PrismaClient) => {
    for (const [tag, tenantId] of [['a', tenants.a], ['b', tenants.b]] as const) {
      const T = (name: string) => `${tag}-${name}`;
      await client.$executeRawUnsafe(`INSERT INTO "Tenant"(id,name,slug,"updatedAt") VALUES ($1,$2,$3,now())`, tenantId, `Restaurante ${tag.toUpperCase()}`, `legacy-${tag}-${id}`);
      await client.$executeRawUnsafe(`INSERT INTO "Unit"(id,"tenantId",name,"updatedAt") VALUES ($1,$2,'Matriz',now())`, T('unit'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",name,email,"passwordHash","updatedAt") VALUES ($1,$2,'Gerente',$3,'x',now())`, T('user'), tenantId, `gerente-${tag}-${id}@legacy.test`);
      await client.$executeRawUnsafe(`INSERT INTO "ProductCategory"(id,"tenantId",name) VALUES ($1,$2,'Bebidas')`, T('cat'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "Product"(id,"tenantId",name,price,"updatedAt") VALUES ($1,$2,'Suco',12.50,now()), ($3,$2,'Prato',34.90,now())`, T('prod1'), tenantId, T('prod2'));
      await client.$executeRawUnsafe(`INSERT INTO "Order"(id,"tenantId",code,subtotal,total,"updatedAt") VALUES ($1,$2,'A-1',90.30,90.30,now())`, T('ord1'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "OrderItem"(id,"orderId","productId",quantity,"unitPrice",total,"updatedAt") VALUES ($1,$2,$3,3,12.50,37.50,now()), ($4,$2,$5,2,34.90,69.80,now())`, T('item1'), T('ord1'), T('prod1'), T('item2'), T('prod2'));
      await client.$executeRawUnsafe(`INSERT INTO "FinancialEntry"(id,"tenantId",description,type,amount) VALUES ($1,$2,'Aluguel antigo','EXPENSE',1500.55)`, T('fin0'), tenantId);
    }
  };
  const seedPreSmart = async (client: PrismaClient) => {
    for (const [tag, tenantId, factor] of [['a', tenants.a, 1], ['b', tenants.b, 3]] as const) {
      const T = (name: string) => `${tag}-${name}`;
      await client.$executeRawUnsafe(`INSERT INTO "Supplier"(id,"tenantId",name,document) VALUES ($1,$2,'Distribuidora Ficticia','11222333000181')`, T('sup'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "Customer"(id,"tenantId",name,phone,"updatedAt") VALUES ($1,$2,'Cliente Ficticio','11999990000',now())`, T('cus'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "Product"(id,"tenantId",name,price,cost,"categoryId","updatedAt") VALUES ($1,$2,'Hambúrguer',28.00,11.37,$3,now())`, T('prod3'), tenantId, T('cat'));
      await client.$executeRawUnsafe(`UPDATE "Product" SET cost = 3.1 * ${factor}, "categoryId" = $2 WHERE id = $1`, T('prod1'), T('cat'));
      await client.$executeRawUnsafe(`INSERT INTO "Order"(id,"tenantId",code,subtotal,total,"customerId","updatedAt",status,channel) VALUES ($1,$2,'A-2',${56 * factor},${56 * factor},$3,now(),'COMPLETED','POS')`, T('ord2'), tenantId, T('cus'));
      await client.$executeRawUnsafe(`INSERT INTO "OrderItem"(id,"orderId","productId",quantity,"unitPrice",total,"updatedAt") VALUES ($1,$2,$3,${2 * factor},28.00,${56 * factor},now())`, T('item3'), T('ord2'), T('prod3'));
      await client.$executeRawUnsafe(`INSERT INTO "Payment"(id,"tenantId",method,amount,"orderId",status,"paidAt") VALUES ($1,$2,'PIX',${56 * factor},$3,'CONFIRMED',now())`, T('pay1'), tenantId, T('ord2'));
      await client.$executeRawUnsafe(`INSERT INTO "FinancialEntry"(id,"tenantId",description,type,amount,"dueAt",status,"paidAmount",reference) VALUES ($1,$2,'Fornecedor NF 10 (parcial)','EXPENSE',${1000 * factor}.37,'2026-03-10 12:00','OPEN',${400 * factor}.12,'NF-10')`, T('fin1'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "FinancialEntry"(id,"tenantId",description,type,amount,"dueAt","settledAt",status,"paidAmount") VALUES ($1,$2,'Energia','EXPENSE',${300 * factor}.99,'2026-03-05 12:00','2026-03-04 12:00','PAID',${300 * factor}.99)`, T('fin2'), tenantId);
      await client.$executeRawUnsafe(`INSERT INTO "FinancialEntry"(id,"tenantId",description,type,amount,"dueAt",status,"customerId","debtorName","paidAmount") VALUES ($1,$2,'Fiado Cliente','INCOME',${80 * factor}.50,'2026-03-20 12:00','OPEN',$3,'Cliente Ficticio',0)`, T('fin3'), tenantId, T('cus'));
      await client.$executeRawUnsafe(`INSERT INTO "FinancialCategory"(id,"tenantId",type,name) VALUES ($1,$2,'EXPENSE','Aluguel')`, T('fcat'), tenantId);
    }
  };

  let legacy: { url: string; client: PrismaClient; name: string };
  let beforeSnapshot: Snapshot; let beforeAggregates: Awaited<ReturnType<typeof aggregates>>;

  await t.test('B/C/D — legacy data survives every migration stage: row-by-row, column-by-column, per tenant', async () => {
    legacy = await newDb('legacy');
    // Stage 1: the very first schema, with data
    const initial = staged(['20261117014958_init']); assert.equal(deploy(legacy.url, initial.schema).status, 0);
    await seedInit(legacy.client);
    const s1 = await snapshot(legacy.client);
    // Stage 2: everything up to just before the RM Smart Migration, then richer financial data
    const mid = staged(upTo(BEFORE_SMART)); const midRun = deploy(legacy.url, mid.schema); assert.equal(midRun.status, 0, midRun.out);
    const s1after = await snapshot(legacy.client);
    const early = compareSnapshots(s1, s1after);
    assert.deepEqual(early.problems, [], `init → ${BEFORE_SMART}:\n${early.problems.slice(0, 20).join('\n')}`);
    t.diagnostic(`init → pre-smart: ${early.rows} rows / ${early.cells} cells compared, 0 differences; rows added by data migrations: ${JSON.stringify(early.added)}`);
    const q1 = (await legacy.client.$queryRawUnsafe<{ quantity: unknown }[]>(`SELECT quantity FROM "OrderItem" WHERE id = $1`, 'a-item1'))[0].quantity;
    assert.equal(Number(q1), 3, 'integer quantity widened to decimal(12,3) without change');
    await seedPreSmart(legacy.client);
    beforeSnapshot = await snapshot(legacy.client); beforeAggregates = await aggregates(legacy.client);
    assert.ok(beforeAggregates.financial.length === 2 && beforeAggregates.orders.length === 2);
    // Stage 3: the four RM Smart Migration migrations (and anything after)
    const rest = allMigrations.filter(name => name > BEFORE_SMART);
    assert.deepEqual(rest.slice(0, 4), NEW_FOUR, 'the four audited migrations follow the pre-smart state');
    const full = staged(allMigrations); const run = deploy(legacy.url, full.schema); assert.equal(run.status, 0, run.out);
    const afterSnapshot = await snapshot(legacy.client);
    const late = compareSnapshots(beforeSnapshot, afterSnapshot);
    assert.deepEqual(late.problems, [], `${BEFORE_SMART} → latest:\n${late.problems.slice(0, 20).join('\n')}`);
    t.diagnostic(`pre-smart → latest: ${late.rows} rows / ${late.cells} cells compared, 0 differences; rows added: ${JSON.stringify(late.added)}`);
    // Only the catalog row of the multi-unit module is data (20261122000000_module_network); existing rows are compared cell by cell above and unchanged.
    assert.deepEqual(late.added, { SaaSModule: 1 }, 'later migrations add structure and the one catalog row of the multi-unit module: nothing else is added or changed');
    // Financial / commercial aggregates per tenant are identical (to the cent)
    assert.deepEqual(normalise(await aggregates(legacy.client)), normalise(beforeAggregates), 'financial, product, order and payment totals per tenant are unchanged');
    // New columns on old rows: safe defaults, nothing invented
    const entry = (await legacy.client.$queryRawUnsafe<any[]>(`SELECT "discountAmount","interestAmount","updatedAt","supplierId","costCenterId","bankAccountId","documentNumber","paidAmount",amount::text AS amount FROM "FinancialEntry" WHERE id = 'a-fin1'`))[0];
    assert.equal(Number(entry.discountAmount), 0); assert.equal(Number(entry.interestAmount), 0); assert.ok(entry.updatedAt); assert.equal(entry.supplierId, null); assert.equal(entry.costCenterId, null); assert.equal(entry.bankAccountId, null); assert.equal(entry.documentNumber, null);
    assert.equal(entry.amount, '1000.37'); assert.equal(Number(entry.paidAmount), 400.12);
    assert.equal((await legacy.client.$queryRawUnsafe<any[]>(`SELECT "unitCost" FROM "OrderItem" WHERE id = 'a-item3'`))[0].unitCost, null, 'historical sales have no invented frozen cost');
    for (const table of ['ProductPricing', 'PriceHistory', 'MigrationSession', 'MigrationBackup', 'CostCenter', 'BankAccount']) assert.equal((await legacy.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(table)}`))[0].n, 0);
    // Relationships: every FK validated, nothing crosses tenants (parent and child both carry tenantId)
    assert.equal((await legacy.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_constraint WHERE NOT convalidated`))[0].n, 0);
    const crossing = await legacy.client.$queryRawUnsafe<{ child: string; fk: string; n: number }[]>(`
      SELECT child.relname AS child, c.conname AS fk, 0 AS n FROM pg_constraint c JOIN pg_class child ON child.oid = c.conrelid JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f' AND array_length(c.conkey,1) = 1
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = child.relname AND column_name = 'tenantId' AND table_schema='public')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = parent.relname AND column_name = 'tenantId' AND table_schema='public')
        AND parent.relname <> 'Tenant'`);
    let crossed = 0;
    for (const fk of crossing) {
      const [info] = await legacy.client.$queryRawUnsafe<{ child: string; col: string; parent: string; pcol: string }[]>(`SELECT cl.relname AS child, a.attname AS col, pr.relname AS parent, pa.attname AS pcol FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_class pr ON pr.oid=c.confrelid JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=c.conkey[1] JOIN pg_attribute pa ON pa.attrelid=pr.oid AND pa.attnum=c.confkey[1] WHERE c.conname = $1`, fk.fk);
      crossed += (await legacy.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(info.child)} ch JOIN ${q(info.parent)} p ON p.${q(info.pcol)} = ch.${q(info.col)} WHERE ch."tenantId" <> p."tenantId"`))[0].n;
    }
    t.diagnostic(`cross-tenant references among ${crossing.length} tenant-scoped foreign keys: ${crossed}`);
    assert.equal(crossed, 0);
    const drift = cli(['migrate', 'diff', '--from-url', legacy.url, '--to-schema-datamodel', join(dbPackage, 'prisma/schema.prisma'), '--exit-code'], legacy.url);
    assert.equal(drift.status, 0, drift.out);
  });

  await t.test('C — pricing, cost history and frozen costs work on the upgraded legacy database, per tenant', async () => {
    const db = legacy.client;
    await db.productPricing.create({ data: { tenantId: tenants.a, productId: 'a-prod3', marginPercent: 35, taxPercent: 6 } });
    await db.priceHistory.create({ data: { tenantId: tenants.a, productId: 'a-prod3', price: 28, cost: 11.37, reason: 'LEGACY_SNAPSHOT' } });
    await db.orderItem.update({ where: { id: 'a-item3' }, data: { unitCost: 11.37 } });
    assert.equal((await db.$queryRawUnsafe<any[]>(`SELECT "unitCost"::text AS c FROM "OrderItem" WHERE id='a-item3'`))[0].c, '11.3700');
    await assert.rejects(db.productPricing.create({ data: { tenantId: tenants.a, productId: 'a-prod3' } }), /Unique constraint/, 'one pricing row per product');
    await assert.rejects(db.priceHistory.create({ data: { tenantId: tenants.a, productId: 'missing-product', price: 1, reason: 'x' } }), /Foreign key/, 'history needs an existing product');
    // Tenant B has none of it and its totals did not move
    assert.equal(await db.priceHistory.count({ where: { tenantId: tenants.b } }), 0); assert.equal(await db.productPricing.count({ where: { tenantId: tenants.b } }), 0);
    assert.deepEqual(normalise(await aggregates(db)), normalise(beforeAggregates));
  });

  await t.test('E/D — application suites (financial, pricing, profit, Smart Migration, backup & restore, tenant isolation) pass on the upgraded legacy database', async () => {
    const files = ['src/routes/pricing.integration.test.ts', 'src/routes/profit-support.integration.test.ts', 'src/routes/migrations.integration.test.ts', 'src/routes/migrations-finance.integration.test.ts', 'src/routes/migration-backup.integration.test.ts', 'src/routes/tenant-isolation.integration.test.ts', 'src/routes/integration.test.ts'];
    // NODE_TEST_CONTEXT must not leak into the nested runner, otherwise it would behave as a subtest and run nothing.
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: legacy.url, RUN_DB_TESTS: '1' };
    for (const key of ['NODE_TEST_CONTEXT', 'MIGRATION_BACKUP_DIR', 'MIGRATION_BACKUP_VERIFY_DATABASE_URL', 'MIGRATION_REQUIRE_BACKUP', 'MIGRATION_BACKUP_ENCRYPTION_KEY']) delete env[key];
    const result = spawnSync('npx', ['--no-install', 'tsx', '--test', '--test-reporter=tap', ...files], { cwd: apiRoot, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 256 * 1024 * 1024 });
    const summary = Object.fromEntries([...`${result.stdout}`.matchAll(/^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)/gm)].map(match => [match[1], Number(match[2])]));
    t.diagnostic(`application suites on the upgraded DB: ${JSON.stringify(summary)}`);
    assert.equal(result.status, 0, `${result.stdout.split('\n').filter(line => /✖|not ok|Error/.test(line)).slice(0, 15).join('\n')}\n${result.stderr.slice(-800)}`);
    assert.ok((summary.pass ?? 0) > 0 && summary.fail === 0 && summary.skipped === 0);
  });

  await t.test('D — deleting one restaurant removes only its rows; the other keeps every record and total', async () => {
    const db = legacy.client;
    const keep = normalise((await aggregates(db)).financial.filter((row: any) => row.tenantId === tenants.a));
    // Sales history is protected: OrderItem → Product is RESTRICT, so a restaurant with orders cannot be hard-deleted by accident.
    await assert.rejects(db.tenant.delete({ where: { id: tenants.b } }), /OrderItem_productId_fkey/);
    assert.deepEqual(normalise((await aggregates(db)).financial.filter((row: any) => row.tenantId === tenants.a)), keep);
    await db.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "tenantId" = $1`, tenants.b); await db.$executeRawUnsafe(`DELETE FROM "Order" WHERE "tenantId" = $1`, tenants.b);
    await db.tenant.delete({ where: { id: tenants.b } });
    assert.deepEqual(normalise((await aggregates(db)).financial.filter((row: any) => row.tenantId === tenants.a)), keep);
    for (const table of ['Product', 'Customer', 'Supplier', 'FinancialEntry', 'FinancialCategory', 'Payment', 'ProductPricing', 'PriceHistory', 'MigrationSession', 'MigrationBackup', 'User']) assert.equal((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(table)} WHERE "tenantId" = $1`, tenants.b))[0].n, 0, `${table} of the deleted restaurant`);
        assert.equal(await db.product.count({ where: { tenantId: tenants.a } }), 3, 'restaurant A keeps its products');
  });

  await t.test('F — interruption: a failing migration leaves the database at the last completed migration, identifiable and recoverable', async () => {
    const db = await newDb('fail');
    const mid = staged(upTo(BEFORE_SMART)); assert.equal(deploy(db.url, mid.schema).status, 0);
    await seedInit(db.client);
    const tenantRows = Number((await db.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "Tenant"`))[0].n);
    const realSql = spawnSync('cat', [join(dbPackage, 'prisma/migrations', SMART, 'migration.sql')], { encoding: 'utf8' }).stdout;
    // Same migration with a fault injected after most of its statements ran (simulates a crash in the middle of the file).
    const faulty = staged(allMigrations.filter(name => (!NEW_FOUR.includes(name) && name !== TEF_CORE && name !== SUPER_AI && name !== PRINT_DEDUP && name !== MIGRATION_UNIT && name !== CRM_LOYALTY && name !== STOCK_INTELLIGENCE && name !== SERVICE_FLOW && name !== AUTOMATIONS && name !== COMMISSION_RULES && name !== UNIT_PRICES && name !== RECON_CLOSINGS && name !== KDS_STAGES && name !== MODULE_NETWORK && name !== WHATSAPP_DB_AUTH && name !== WORKER_HEARTBEAT) || name === SMART), { [SMART]: `${realSql}\nINSERT INTO "TabelaQueNaoExiste" VALUES (1);\n` });
    const failed = deploy(db.url, faulty.schema);
    assert.notEqual(failed.status, 0, 'deploy must fail');
    assert.match(failed.out, new RegExp(SMART));
    // Exactly which migrations completed
    const rows = await db.client.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; logs: string | null }[]>(`SELECT migration_name, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY started_at, migration_name`);
    const done = rows.filter(row => row.finished_at).map(row => row.migration_name); const pending = rows.filter(row => !row.finished_at);
    assert.deepEqual(done, upTo(BEFORE_SMART), 'every migration before the failing one is complete');
    assert.deepEqual(pending.map(row => row.migration_name), [SMART], 'the failing migration is recorded as unfinished');
    assert.match(pending[0].logs ?? '', /TabelaQueNaoExiste/);
    // Atomic: nothing of the failed migration is left behind and the data is untouched
    assert.equal((await db.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'Migration%'`))[0].n, 0, 'no partial tables');
    assert.equal(Number((await db.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "Tenant"`))[0].n), tenantRows);
    const status = cli(['migrate', 'status'], db.url, faulty.schema);
    assert.notEqual(status.status, 0); assert.match(status.out, /failed|Following migration have failed/i); assert.match(status.out, new RegExp(SMART));
    // A new deploy refuses to proceed blindly (P3009) until the failure is resolved explicitly
    const blocked = deploy(db.url, faulty.schema); assert.notEqual(blocked.status, 0); assert.match(blocked.out, /P3009|failed migrations/i);
    // Recovery: mark rolled back, apply the real chain
    const resolved = cli(['migrate', 'resolve', '--rolled-back', SMART], db.url, faulty.schema); assert.equal(resolved.status, 0, resolved.out);
    const full = staged(allMigrations); const recovered = deploy(db.url, full.schema); assert.equal(recovered.status, 0, recovered.out);
    const final = await db.client.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
    assert.deepEqual(final.map(row => row.migration_name), allMigrations);
    assert.equal(cli(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', join(dbPackage, 'prisma/schema.prisma'), '--exit-code'], db.url).status, 0);
    t.diagnostic(`F: failure injected in ${SMART}; ${done.length} migrations stayed complete, failing one rolled back atomically, deploy blocked (P3009) until resolved, recovered to ${final.length}/${allMigrations.length}`);
  });
});
