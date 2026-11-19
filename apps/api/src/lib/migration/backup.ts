import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Prisma, PrismaClient, type MigrationBackup, type MigrationSession } from '@prisma/client';
import { prisma } from '../prisma';
import { BackupFileError, DigestSet, parseEncryptionKey, readBackupRows, verifyBackupFile, writeBackupFile, type BackupDatabase, type BackupFooter, type BackupHeader, type TableDigest } from './backup-file';

// Pre-migration backup for RM Smart Migration. The platform generates a tenant-scoped logical backup of every table the engine writes, stores it outside
// the database, re-reads it and RESTORES it into an isolated target, comparing the restored rows with the originals. Only a backup that went through
// all of that (status VERIFIED) can release the approval of a migration; an operator's statement is never accepted as proof.

// Every model the executor creates/updates/deletes (guarded by a unit test that scans executor.ts). Order is irrelevant: restore has no foreign keys.
export const BACKUP_MODELS = ['ProductCategory', 'Product', 'ProductStockMovement', 'Customer', 'Supplier', 'FinancialCategory', 'CostCenter', 'BankAccount', 'FinancialEntry', 'Employee', 'Order', 'OrderItem', 'Payment'] as const;
// OrderItem has no tenantId column: it belongs to the tenant through its order.
const TENANT_SCOPE: Record<string, string> = { OrderItem: 't."orderId" IN (SELECT o.id FROM "Order" o WHERE o."tenantId" = $1)' };
export const scopeOf = (table: string) => TENANT_SCOPE[table] ?? 't."tenantId" = $1';

const modelMeta = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
export const tableOf = (model: string) => { const meta = modelMeta.get(model); if (!meta) throw new Error(`Modelo desconhecido: ${model}`); return meta.dbName ?? meta.name; };
const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const PAGE = 2000;

export class BackupError extends Error { constructor(message: string, readonly status = 422, readonly details?: unknown) { super(message); } }

export const backupRequired = () => process.env.MIGRATION_REQUIRE_BACKUP === 'true' || (process.env.NODE_ENV === 'production' && process.env.MIGRATION_REQUIRE_BACKUP !== 'false');
const maxAgeMinutes = () => { const value = Number(process.env.MIGRATION_BACKUP_MAX_AGE_MINUTES); return Number.isFinite(value) && value > 0 ? value : 60; };

export function backupPolicy() {
  const verifyUrl = process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL;
  return {
    required: backupRequired(), maxAgeMinutes: maxAgeMinutes(), tables: BACKUP_MODELS.map(tableOf),
    storageConfigured: Boolean(process.env.MIGRATION_BACKUP_DIR) || process.env.NODE_ENV !== 'production',
    encrypted: Boolean(process.env.MIGRATION_BACKUP_ENCRYPTION_KEY),
    restoreTarget: verifyUrl ? 'separate-database' as const : 'scratch-schema' as const,
  };
}

function storageRoot() {
  const configured = process.env.MIGRATION_BACKUP_DIR;
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === 'production') throw new BackupError('Armazenamento de backup não configurado: defina MIGRATION_BACKUP_DIR no servidor.', 503);
  return join(tmpdir(), 'rm-migration-backups');
}
function encryptionKey() {
  let key: Buffer | null;
  try { key = parseEncryptionKey(process.env.MIGRATION_BACKUP_ENCRYPTION_KEY); } catch (error) { throw new BackupError((error as Error).message, 503); }
  if (!key && (backupRequired() || process.env.NODE_ENV === 'production')) throw new BackupError('Chave de criptografia de backup não configurada: defina MIGRATION_BACKUP_ENCRYPTION_KEY (32 bytes, hex ou base64). Backups contêm dados pessoais e não são gravados sem criptografia em produção.', 503);
  return key;
}
const fileKeyOf = (tenantId: string, sessionId: string, backupId: string) => join(tenantId, sessionId, `${backupId}.rmbk`);
function pathOf(fileKey: string) {
  const root = storageRoot(); const full = resolve(root, fileKey); const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new BackupError('Caminho de backup inválido.', 500);
  return full;
}
async function assertStorageWritable() {
  const root = storageRoot(); const probe = join(root, `.probe-${randomBytes(6).toString('hex')}`);
  try { await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(probe, 'ok', { mode: 0o600 }); await rm(probe, { force: true }); }
  catch (error) { throw new BackupError(`Armazenamento de backup indisponível: ${(error as Error).message}`, 503); }
}

function identityOf(url: string | undefined, name: string): BackupDatabase {
  let host = 'desconhecido'; let port = '';
  try { const parsed = new URL(url ?? ''); host = parsed.hostname; port = parsed.port; } catch { /* identity falls back to the database name */ }
  return { name, host, fingerprint: createHash('sha256').update(`${host}:${port}/${name}`).digest('hex').slice(0, 16) };
}
async function currentDatabase(client: Pick<PrismaClient, '$queryRaw'>, url: string | undefined) {
  const [row] = await client.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  return identityOf(url, row.name);
}

type Verifier = { client: PrismaClient; mode: 'separate-database' | 'scratch-schema'; close: () => Promise<void> };
function verifier(): Verifier {
  const url = process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL;
  if (!url) return { client: prisma as unknown as PrismaClient, mode: 'scratch-schema', close: async () => undefined };
  const client = new PrismaClient({ datasources: { db: { url } } });
  return { client, mode: 'separate-database', close: () => client.$disconnect() };
}

export type TableComparison = { table: string; backup: TableDigest; restored: TableDigest; match: boolean };
export type RelationshipCheck = { from: string; field: string; to: string; orphans: number };
export type RestoreEvidence = { ok: boolean; mode: Verifier['mode']; target: BackupDatabase; schema: string; startedAt: string; finishedAt: string; tables: TableComparison[]; relationships: RelationshipCheck[]; foreignTenantRows: number; error?: string };

// Restores the file into scratch tables (same columns, defaults, checks and unique indexes as the live ones; no foreign keys) inside an isolated target, then
// compares per-table counts and content hashes with what was exported and checks the relationships between the restored tables. The scratch schema is always dropped.
export async function restoreAndCompare(path: string, key: Buffer | null, identity: { backupId: string; tenantId: string; sessionId: string }): Promise<RestoreEvidence> {
  const target = verifier(); const startedAt = new Date().toISOString();
  const schema = `rmbk_${randomBytes(6).toString('hex')}`;
  const evidence: RestoreEvidence = { ok: false, mode: target.mode, target: identityOf(process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL ?? process.env.DATABASE_URL, 'desconhecido'), schema, startedAt, finishedAt: startedAt, tables: [], relationships: [], foreignTenantRows: 0 };
  try {
    const db = target.client;
    evidence.target = await currentDatabase(db, process.env.MIGRATION_BACKUP_VERIFY_DATABASE_URL ?? process.env.DATABASE_URL);
    await db.$executeRawUnsafe(`CREATE SCHEMA ${q(schema)}`);
    const tables = BACKUP_MODELS.map(tableOf);
    for (const table of tables) await db.$executeRawUnsafe(`CREATE TABLE ${q(schema)}.${q(table)} (LIKE public.${q(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);

    let batch: string[] = []; let batchTable = '';
    const flush = async () => {
      if (!batch.length) return;
      await db.$executeRawUnsafe(`INSERT INTO ${q(schema)}.${q(batchTable)} SELECT * FROM jsonb_populate_recordset(NULL::public.${q(batchTable)}, $1::jsonb)`, `[${batch.join(',')}]`);
      batch = [];
    };
    const reader = readBackupRows(path, key, identity); let header: BackupHeader; let footer: BackupFooter;
    for (;;) {
      const next = await reader.next();
      if (next.done) { ({ header, footer } = next.value); break; }
      if (next.value.table !== batchTable || batch.length >= 1000) { await flush(); batchTable = next.value.table; }
      batch.push(next.value.text);
    }
    await flush();
    if (header.tenantId !== identity.tenantId) throw new BackupError('O backup pertence a outra empresa.');

    for (const table of tables) {
      const digest = new DigestSet(); let last = '';
      for (;;) {
        const rows = await db.$queryRawUnsafe<{ id: string; j: string }[]>(`SELECT t.id, to_jsonb(t)::text AS j FROM ${q(schema)}.${q(table)} t WHERE t.id COLLATE "C" > $1 ORDER BY t.id COLLATE "C" LIMIT ${PAGE}`, last);
        for (const row of rows) digest.add(table, row.j);
        if (rows.length < PAGE) break; last = rows[rows.length - 1].id;
      }
      const restored = digest.result([table])[table]; const original = footer.tables[table] ?? { count: 0, sha256: '' };
      evidence.tables.push({ table, backup: original, restored, match: restored.count === original.count && restored.sha256 === original.sha256 });
      if (!TENANT_SCOPE[table]) {
        const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${q(schema)}.${q(table)} WHERE "tenantId" <> $1`, identity.tenantId);
        evidence.foreignTenantRows += Number(n);
      }
    }
    for (const model of BACKUP_MODELS) {
      for (const field of modelMeta.get(model)!.fields) {
        if (!field.relationFromFields?.length || !(BACKUP_MODELS as readonly string[]).includes(field.type)) continue;
        const from = q(tableOf(model)); const to = q(tableOf(field.type)); const column = q(field.relationFromFields[0]);
        const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${q(schema)}.${from} a WHERE a.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(schema)}.${to} b WHERE b.id = a.${column})`);
        evidence.relationships.push({ from: tableOf(model), field: field.relationFromFields[0], to: tableOf(field.type), orphans: Number(n) });
      }
    }
    evidence.ok = evidence.tables.every(table => table.match) && evidence.relationships.every(relation => relation.orphans === 0) && evidence.foreignTenantRows === 0;
    if (!evidence.ok) evidence.error = 'A restauração não reproduziu os dados originais ou deixou relacionamentos órfãos.';
  } catch (error) {
    evidence.ok = false; evidence.error = (error instanceof Error ? error.message : String(error)).split('\n').map(line => line.trim()).filter(Boolean).pop();
  } finally {
    try { await target.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`); } catch { /* best effort: the schema name is random and holds only a copy */ }
    await target.close().catch(() => undefined);
    evidence.finishedAt = new Date().toISOString();
  }
  return evidence;
}

export type BackupHooks = { afterExport?: (path: string) => Promise<void> | void };
const creating = new Set<string>();

async function exportTenant(path: string, key: Buffer | null, header: BackupHeader) {
  return prisma.$transaction(async tx => writeBackupFile(path, key, header, async writer => {
    for (const model of BACKUP_MODELS) {
      const table = tableOf(model); let last = '';
      for (;;) {
        const rows = await tx.$queryRawUnsafe<{ id: string; j: string }[]>(`SELECT t.id, to_jsonb(t)::text AS j FROM ${q(table)} t WHERE ${scopeOf(table)} AND t.id COLLATE "C" > $2 ORDER BY t.id COLLATE "C" LIMIT ${PAGE}`, header.tenantId, last);
        for (const row of rows) await writer.row(table, row.j);
        if (rows.length < PAGE) break; last = rows[rows.length - 1].id;
      }
    }
  }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15 * 60 * 1000, maxWait: 15_000 });
}

const stageFailure = (error: unknown): { message: string; stage?: string } => {
  if (error instanceof BackupFileError) return { message: error.message, stage: error.code };
  if (error instanceof BackupError) return { message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
};

// Generates, stores, integrity-checks and restore-tests a backup for the session's restaurant. Never throws for a failed backup: the record is returned with status FAILED.
export async function createBackup(session: MigrationSession, actorUserId: string, engineVersion: string, hooks: BackupHooks = {}): Promise<MigrationBackup> {
  if (!['ANALYZED', 'PREVIEWED'].includes(session.status)) throw new BackupError('O backup deve ser gerado depois da análise e antes da aprovação da execução.', 409);
  if (creating.has(session.id)) throw new BackupError('Já existe um backup em andamento para esta sessão.', 409);
  creating.add(session.id);
  let record: MigrationBackup | null = null;
  try {
    const key = encryptionKey();
    const database = await currentDatabase(prisma, process.env.DATABASE_URL);
    const tenant = await prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { id: true } });
    if (!tenant) throw new BackupError('Restaurante não encontrado.', 404);
    record = await prisma.migrationBackup.create({ data: { tenantId: session.tenantId, sessionId: session.id, createdById: actorUserId, status: 'CREATING', stage: 'STARTED', database: database as unknown as Prisma.InputJsonValue, encrypted: Boolean(key), engineVersion } });
    const recordId = record.id;
    const fail = async (error: unknown, stage: string, extra: Prisma.MigrationBackupUpdateInput = {}) => {
      const failure = stageFailure(error);
      return prisma.migrationBackup.update({ where: { id: recordId }, data: { status: 'FAILED', stage, error: failure.message.slice(0, 1000), ...extra } });
    };
    try { await assertStorageWritable(); } catch (error) { return await fail(error, 'STORAGE'); }
    const fileKey = fileKeyOf(session.tenantId, session.id, record.id); const path = pathOf(fileKey);
    const header: BackupHeader = { type: 'header', format: 'rm-migration-backup', version: 1, backupId: record.id, tenantId: session.tenantId, sessionId: session.id, createdAt: record.createdAt.toISOString(), engineVersion, database, tables: BACKUP_MODELS.map(tableOf) };
    let written;
    try { written = await exportTenant(path, key, header); } catch (error) { return await fail(error, error instanceof BackupFileError ? error.code : 'EXPORT'); }
    const manifest = { backupId: record.id, tenantId: session.tenantId, sessionId: session.id, createdAt: header.createdAt, database, tables: written.footer.tables, totalRows: written.footer.totalRows };
    record = await prisma.migrationBackup.update({ where: { id: record.id }, data: { stage: 'EXPORTED', fileKey, fileSize: written.size, sha256: written.sha256, manifest: manifest as unknown as Prisma.InputJsonValue } });
    try { await hooks.afterExport?.(path); } catch (error) { return await fail(error, 'EXPORT'); }
    return await verifyRecord(record, key, 'create');
  } finally { creating.delete(session.id); }
}

// Integrity check + restore test of an existing backup record; updates its status (VERIFIED / FAILED).
async function verifyRecord(record: MigrationBackup, key: Buffer | null, origin: 'create' | 'reverify'): Promise<MigrationBackup> {
  const identity = { backupId: record.id, tenantId: record.tenantId, sessionId: record.sessionId };
  const startedAt = new Date().toISOString();
  const failed = (message: string, stage: string, verification: Record<string, unknown>) => prisma.migrationBackup.update({ where: { id: record.id }, data: { status: 'FAILED', stage, error: message.slice(0, 1000), verification: { ...verification, ok: false, startedAt, finishedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } });
  let integrity;
  try {
    if (!record.fileKey || !record.sha256) throw new BackupFileError('MISSING', 'O registro de backup não possui arquivo.');
    integrity = await verifyBackupFile(pathOf(record.fileKey), key, { sha256: record.sha256, size: record.fileSize }, identity);
    const manifest = record.manifest as unknown as { tables?: Record<string, TableDigest> } | null;
    for (const [table, digest] of Object.entries(integrity.footer.tables)) if (manifest?.tables?.[table]?.sha256 !== digest.sha256 || manifest?.tables?.[table]?.count !== digest.count) throw new BackupFileError('CORRUPT', `O conteúdo da tabela ${table} difere do manifesto registrado.`);
  } catch (error) {
    const failure = stageFailure(error);
    return failed(failure.message, `INTEGRITY${failure.stage ? `:${failure.stage}` : ''}`, { origin, integrity: { ok: false, error: failure.message } });
  }
  const integritySummary = { ok: true, sha256: integrity.sha256, size: integrity.size, rows: integrity.footer.totalRows };
  const restore = await restoreAndCompare(pathOf(record.fileKey!), key, identity);
  if (!restore.ok) return failed(`Restauração de validação falhou: ${restore.error ?? 'divergência nos dados restaurados'}`, 'RESTORE', { origin, integrity: integritySummary, restore });
  const verifiedAt = new Date();
  return prisma.migrationBackup.update({ where: { id: record.id }, data: { status: 'VERIFIED', stage: 'VERIFIED', error: null, verifiedAt, verification: { origin, ok: true, startedAt, finishedAt: verifiedAt.toISOString(), integrity: integritySummary, restore } as unknown as Prisma.InputJsonValue } });
}

export async function reverifyBackup(session: MigrationSession, backupId: string): Promise<MigrationBackup> {
  const record = await prisma.migrationBackup.findFirst({ where: { id: backupId, tenantId: session.tenantId, sessionId: session.id } });
  if (!record) throw new BackupError('Backup não encontrado nesta sessão.', 404);
  if (record.status === 'CREATING') throw new BackupError('O backup ainda está sendo gerado.', 409);
  if (creating.has(session.id)) throw new BackupError('Já existe uma operação de backup em andamento para esta sessão.', 409);
  creating.add(session.id);
  try { return await verifyRecord(record, encryptionKey(), 'reverify'); } finally { creating.delete(session.id); }
}

export async function listBackups(session: Pick<MigrationSession, 'id' | 'tenantId'>) {
  const rows = await prisma.migrationBackup.findMany({ where: { tenantId: session.tenantId, sessionId: session.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  return rows.map(({ fileKey, ...rest }) => ({ ...rest, stored: Boolean(fileKey) }));
}

// The approval gate. Throws BackupError unless the session's own newest backup is VERIFIED, belongs to this restaurant/session/database, is recent, still
// passes the integrity check on disk right now and carries a successful restore test. Anything else (missing, failed, corrupt, foreign) blocks.
export async function assertRecoverableBackup(session: Pick<MigrationSession, 'id' | 'tenantId'>, options: { checkAge?: boolean } = {}): Promise<MigrationBackup> {
  const latest = await prisma.migrationBackup.findFirst({ where: { tenantId: session.tenantId, sessionId: session.id }, orderBy: { createdAt: 'desc' } });
  if (!latest) throw new BackupError('Nenhum backup validado para esta migração: gere o backup e aguarde a validação da restauração antes de autorizar.');
  if (latest.status !== 'VERIFIED') throw new BackupError(`O backup mais recente desta migração não está validado (situação: ${latest.status}${latest.error ? ` — ${latest.error}` : ''}). Gere um novo backup ou repita a validação.`);
  const manifest = latest.manifest as unknown as { backupId?: string; tenantId?: string; sessionId?: string; createdAt?: string; database?: BackupDatabase } | null;
  const verification = latest.verification as unknown as { ok?: boolean; restore?: RestoreEvidence } | null;
  if (latest.tenantId !== session.tenantId || latest.sessionId !== session.id || manifest?.tenantId !== session.tenantId || manifest?.sessionId !== session.id || manifest?.backupId !== latest.id) throw new BackupError('O backup não pertence a esta empresa/operação de migração.');
  if (!verification?.ok || !verification.restore?.ok || verification.restore.tables.some(table => !table.match) || verification.restore.relationships.some(relation => relation.orphans > 0)) throw new BackupError('A restauração de validação deste backup não foi concluída com sucesso.');
  const database = await currentDatabase(prisma, process.env.DATABASE_URL);
  if (manifest.database?.fingerprint !== database.fingerprint) throw new BackupError('O backup foi gerado a partir de outro banco de dados.');
  if (options.checkAge !== false) {
    const ageMinutes = (Date.now() - latest.createdAt.getTime()) / 60000;
    if (ageMinutes > maxAgeMinutes()) throw new BackupError(`O backup validado tem mais de ${maxAgeMinutes()} minutos; gere um novo imediatamente antes de autorizar.`);
  }
  try {
    if (!latest.fileKey || !latest.sha256) throw new BackupFileError('MISSING', 'O registro de backup não possui arquivo.');
    await verifyBackupFile(pathOf(latest.fileKey), encryptionKey(), { sha256: latest.sha256, size: latest.fileSize }, { backupId: latest.id, tenantId: session.tenantId, sessionId: session.id });
  } catch (error) {
    if (error instanceof BackupError) throw error;
    const failure = stageFailure(error);
    await prisma.migrationBackup.update({ where: { id: latest.id }, data: { status: 'INVALID', error: failure.message.slice(0, 1000) } });
    throw new BackupError(`O arquivo de backup não passou na verificação de integridade: ${failure.message}`);
  }
  return latest;
}
