import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';
import { currentAiProvider } from '../lib/ai-provider';
import { BATCH_SIZE, rollbackSession, runMigration, STALE_RUNNING_MS } from '../lib/migration/executor';
import { assertRecoverableBackup, BackupError, backupPolicy, backupRequired, createBackup, listBackups, reverifyBackup } from '../lib/migration/backup';
import { buildPdf, buildReport, reportLines, SESSION_STATUS_LABEL, streamCsv } from '../lib/migration/report';
import { detectFormat, MAX_FILE_BYTES, MAX_ROWS_PER_TABLE, sha256, UnsupportedFileError } from '../lib/migration/readers';
import { analyzeSession, approveExecution, ENGINE_VERSION, getSession, logEvent, mappingInput, MigrationError, previewSession, recordPatch, reopenSession, reviewRecord, updateMapping } from '../lib/migration/service';
import { ENTITIES, GROUPS, UNSUPPORTED_MODULES } from '../lib/migration/targets';

// RM Smart Migration is operated exclusively from the RM Painel Admin (MASTER_ADMIN). Every session route is nested under its restaurant, and the
// session is always looked up *with* that tenant id, so a session can never be reached (or written to) through another restaurant's path.
export const migrationRoutes = Router();
migrationRoutes.use(requireAuth, requireMaster);

const BACKGROUND_THRESHOLD = 2000;
const MAX_FILES = 20; const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const running = new Set<string>();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const handle = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req, res).catch(error => {
    if (error instanceof MigrationError || error instanceof BackupError) return res.status(error.status).json({ message: error.message, ...(error.details ? { details: error.details } : {}) });
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Validation failed', errors: error.flatten() });
    return next(error);
  });
};
const uuid = z.string().uuid();
async function scope(req: Request) {
  const tenantId = uuid.safeParse(req.params.tenantId); const sessionId = uuid.safeParse(req.params.sessionId);
  if (!tenantId.success || !sessionId.success) throw new MigrationError('Identificador inválido.', 400);
  return getSession(tenantId.data, sessionId.data);
}
async function actor(req: Request) {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } });
  return { id: req.auth!.userId, label: user?.name ?? 'Operador RM' };
}
const audit = (tenantId: string, userId: string, action: string, sessionId: string, metadata?: Prisma.InputJsonValue) => prisma.auditLog.create({ data: { tenantId, actorUserId: userId, action, entityType: 'MigrationSession', entityId: sessionId, metadata } });
const publicSession = (session: Awaited<ReturnType<typeof getSession>>) => ({ ...session, analysis: session.analysis ? { ...(session.analysis as object), aiCache: undefined } : null });

migrationRoutes.get('/capabilities', handle(async (_req, res) => res.json({
  engineVersion: ENGINE_VERSION,
  formats: [
    { key: 'csv', label: 'CSV / TXT delimitado', note: 'Detecta separador, cabeçalho e codificação (UTF-8, UTF-16, Windows-1252).' },
    { key: 'xlsx', label: 'Excel (.xlsx)', note: 'Várias planilhas; datas e valores lidos do último cálculo salvo.' },
    { key: 'json', label: 'JSON', note: 'Listas de objetos; objetos aninhados simples são achatados.' },
    { key: 'xml', label: 'XML', note: 'Elementos repetidos com campos simples; DTD/entidades são recusados.' },
    { key: 'sql', label: 'Dump SQL (MySQL/PostgreSQL)', note: 'CREATE TABLE, INSERT e COPY lidos de forma estática; nada é executado.' },
  ],
  unsupportedFormats: ['XLS antigo (BIFF)', 'SQLite binário', 'pg_dump formato customizado', 'arquivos protegidos por senha/criptografados', 'conexão direta com banco externo'],
  groups: GROUPS,
  backupRequired: backupRequired(),
  backup: backupPolicy(),
  entities: Object.values(ENTITIES).map(entity => ({ key: entity.key, label: entity.label, group: entity.group, order: entity.order, fields: entity.fields.map(field => ({ key: field.key, label: field.label, required: Boolean(field.required), kind: field.kind })) })),
  unsupportedModules: UNSUPPORTED_MODULES,
  limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, maxRowsPerTable: MAX_ROWS_PER_TABLE, batchSize: BATCH_SIZE },
  aiAvailable: currentAiProvider() !== null,
})));

// Units of the restaurant being migrated, to choose the destination of unit-bound records (sales, payments, payables/receivables, opening stock, employees).
migrationRoutes.get('/tenants/:tenantId/units', handle(async (req, res) => {
  const tenantId = uuid.safeParse(req.params.tenantId); if (!tenantId.success) throw new MigrationError('Identificador inválido.', 400);
  const items = await prisma.unit.findMany({ where: { tenantId: tenantId.data }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return res.json({ items });
}));

const listQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(100), status: z.enum(Object.keys(SESSION_STATUS_LABEL) as [string, ...string[]]).optional() });
migrationRoutes.get('/tenants/:tenantId/sessions', handle(async (req, res) => {
  const tenantId = uuid.safeParse(req.params.tenantId); if (!tenantId.success) throw new MigrationError('Identificador inválido.', 400);
  const query = listQuery.safeParse(req.query); if (!query.success) throw new MigrationError('Filtros ou paginação inválidos.', 400);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId.data }, select: { id: true, name: true, slug: true, status: true } });
  if (!tenant) throw new MigrationError('Restaurante não encontrado.', 404);
  const where = { tenantId: tenant.id, ...(query.data.status ? { status: query.data.status } : {}) };
  const [items, total] = await Promise.all([
    prisma.migrationSession.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.data.page - 1) * query.data.pageSize, take: query.data.pageSize, select: { id: true, label: true, sourceSystem: true, sourceUnknown: true, status: true, outcome: true, createdAt: true, startedAt: true, finishedAt: true, summary: true } }),
    prisma.migrationSession.count({ where }),
  ]);
  return res.json({ tenant, items, total, page: query.data.page, pageSize: query.data.pageSize });
}));

const createSchema = z.object({ label: z.string().trim().min(2).max(120), sourceSystem: z.string().trim().max(120).optional(), sourceUnknown: z.boolean().default(false), unitId: z.string().uuid().nullable().optional() });
migrationRoutes.post('/tenants/:tenantId/sessions', handle(async (req, res) => {
  const tenantId = uuid.safeParse(req.params.tenantId); if (!tenantId.success) throw new MigrationError('Identificador inválido.', 400);
  const parsed = createSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId.data }, select: { id: true } });
  if (!tenant) throw new MigrationError('Restaurante não encontrado.', 404);
  // The destination unit must belong to the restaurant being migrated: units of other companies are never accepted.
  if (parsed.data.unitId && !await prisma.unit.findFirst({ where: { id: parsed.data.unitId, tenantId: tenant.id }, select: { id: true } })) throw new MigrationError('A unidade escolhida não pertence a este restaurante.', 400);
  const session = await prisma.migrationSession.create({ data: { tenantId: tenant.id, unitId: parsed.data.unitId ?? null, createdById: req.auth!.userId, label: parsed.data.label, sourceSystem: parsed.data.sourceUnknown ? null : parsed.data.sourceSystem || null, sourceUnknown: parsed.data.sourceUnknown, engineVersion: ENGINE_VERSION } });
  await logEvent(session, req.auth!.userId, 'CREATED', `Sessão de migração criada (${parsed.data.sourceUnknown ? 'origem desconhecida' : parsed.data.sourceSystem || 'origem não informada'}).`);
  await audit(tenant.id, req.auth!.userId, 'MIGRATION_CREATED', session.id);
  return res.status(201).json(publicSession(session));
}));

migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId', handle(async (req, res) => {
  const session = await scope(req);
  const files = await prisma.migrationFile.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, size: true, sha256: true, format: true, purgedAt: true, createdAt: true } });
  return res.json({ ...publicSession(session), files });
}));

// Files arrive as the raw request body (octet-stream); everything is validated again when the file is read.
migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/files', raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), handle(async (req, res) => {
  const session = await scope(req);
  if (!['DRAFT', 'ANALYZED', 'PREVIEWED'].includes(session.status)) throw new MigrationError('Arquivos só podem ser adicionados antes da aprovação da execução.');
  const name = z.string().trim().min(1).max(200).safeParse(req.query.name);
  if (!name.success) throw new MigrationError('Informe o nome do arquivo (?name=).', 400);
  const safeName = name.data.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim() || 'arquivo';
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new MigrationError('Arquivo vazio ou corpo da requisição inválido.', 400);
  try { detectFormat(safeName, body); } catch (error) { if (error instanceof UnsupportedFileError) throw new MigrationError(error.message, error.code === 'too_large' ? 413 : 415); throw error; }
  const existing = await prisma.migrationFile.findMany({ where: { sessionId: session.id }, select: { size: true } });
  if (existing.length >= MAX_FILES) throw new MigrationError(`Limite de ${MAX_FILES} arquivos por sessão.`, 422);
  if (existing.reduce((sum, file) => sum + file.size, 0) + body.length > MAX_TOTAL_BYTES) throw new MigrationError('Limite de tamanho total da sessão excedido.', 413);
  const hash = sha256(body);
  try {
    const file = await prisma.migrationFile.create({ data: { sessionId: session.id, tenantId: session.tenantId, name: safeName, size: body.length, sha256: hash, format: 'pending', content: body }, select: { id: true, name: true, size: true, sha256: true } });
    if (session.status !== 'DRAFT') { await prisma.migrationRecord.deleteMany({ where: { sessionId: session.id } }); await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'DRAFT', mapping: Prisma.JsonNull, summary: Prisma.JsonNull } }); }
    await logEvent(session, req.auth!.userId, 'FILE_ADDED', `Arquivo recebido: ${safeName} (${body.length} bytes).`, { sha256: hash });
    return res.status(201).json(file);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new MigrationError('Este mesmo arquivo já foi enviado nesta sessão.');
    throw error;
  }
}));

migrationRoutes.delete('/tenants/:tenantId/sessions/:sessionId/files/:fileId', handle(async (req, res) => {
  const session = await scope(req);
  if (!['DRAFT', 'ANALYZED', 'PREVIEWED'].includes(session.status)) throw new MigrationError('Arquivos só podem ser removidos antes da aprovação da execução.');
  const fileId = uuid.safeParse(req.params.fileId); if (!fileId.success) throw new MigrationError('Identificador inválido.', 400);
  const removed = await prisma.migrationFile.deleteMany({ where: { id: fileId.data, sessionId: session.id } });
  if (removed.count === 0) throw new MigrationError('Arquivo não encontrado.', 404);
  await prisma.migrationRecord.deleteMany({ where: { sessionId: session.id } });
  await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'DRAFT', mapping: Prisma.JsonNull, analysis: Prisma.JsonNull, summary: Prisma.JsonNull } });
  await logEvent(session, req.auth!.userId, 'FILE_REMOVED', 'Arquivo removido; análise anterior descartada.');
  return res.status(204).end();
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/analyze', handle(async (req, res) => {
  const session = await scope(req);
  const body = z.object({ useAi: z.boolean().default(false) }).parse(req.body ?? {});
  return res.json(await analyzeSession(session, req.auth!.userId, { useAi: body.useAi }));
}));

migrationRoutes.put('/tenants/:tenantId/sessions/:sessionId/mapping', handle(async (req, res) => {
  const session = await scope(req);
  return res.json({ mapping: await updateMapping(session, req.auth!.userId, mappingInput.parse(req.body)) });
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/preview', handle(async (req, res) => {
  const session = await scope(req);
  return res.json({ summary: await previewSession(session, req.auth!.userId) });
}));

migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/records', handle(async (req, res) => {
  const session = await scope(req);
  const query = z.object({
    entity: z.enum(['CATEGORY', 'PRODUCT', 'CUSTOMER', 'SUPPLIER', 'FIN_CATEGORY', 'COST_CENTER', 'BANK_ACCOUNT', 'PAYABLE', 'RECEIVABLE', 'EMPLOYEE', 'SALE', 'SALE_ITEM']).optional(),
    group: z.enum(['products', 'customers', 'suppliers', 'payables', 'receivables', 'finance', 'employees', 'sales']).optional(),
    status: z.enum(['VALID', 'DIVERGENT', 'DUPLICATE', 'REJECTED', 'IGNORED', 'IMPORTED', 'FAILED', 'REVERTED']).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  }).parse(req.query);
  const where = { sessionId: session.id, tenantId: session.tenantId, ...(query.entity ? { entity: query.entity } : query.group ? { entity: { in: GROUPS.find(group => group.key === query.group)!.entities } } : {}), ...(query.status ? { status: query.status } : {}) };
  const [items, total] = await Promise.all([
    prisma.migrationRecord.findMany({ where, orderBy: [{ entity: 'asc' }, { tableName: 'asc' }, { rowIndex: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.migrationRecord.count({ where }),
  ]);
  return res.json({ items, total, page: query.page, pageSize: query.pageSize });
}));

migrationRoutes.patch('/tenants/:tenantId/sessions/:sessionId/records/:recordId', handle(async (req, res) => {
  const session = await scope(req);
  const recordId = uuid.safeParse(req.params.recordId); if (!recordId.success) throw new MigrationError('Identificador inválido.', 400);
  const record = await prisma.migrationRecord.findFirst({ where: { id: recordId.data, sessionId: session.id, tenantId: session.tenantId } });
  if (!record) throw new MigrationError('Registro não encontrado nesta sessão.', 404);
  const who = await actor(req);
  return res.json(await reviewRecord(session, record, who.id, who.label, recordPatch.parse(req.body)));
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/bulk-approve', handle(async (req, res) => {
  const session = await scope(req);
  if (session.status !== 'PREVIEWED') throw new MigrationError('Disponível apenas na pré-visualização.');
  // Only records with no pending review item are touched: "approve everything that is safe".
  const result = await prisma.migrationRecord.updateMany({ where: { sessionId: session.id, tenantId: session.tenantId, status: 'VALID', approved: false }, data: { approved: true } });
  await logEvent(session, req.auth!.userId, 'BULK_APPROVED', `${result.count} registro(s) seguros aprovados em lote.`);
  return res.json({ approved: result.count });
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/approve', handle(async (req, res) => {
  const session = await scope(req);
  const approval = z.object({ confirm: z.literal('EXECUTAR') }).safeParse(req.body);
  if (!approval.success) throw new MigrationError('Autorização explícita ausente: envie confirm = "EXECUTAR".', 422);
  const who = await actor(req);
  const updated = await approveExecution(session, who.id, who.label);
  await audit(session.tenantId, who.id, 'MIGRATION_APPROVED', session.id);
  return res.json(publicSession(updated));
}));

migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/backups', handle(async (req, res) => res.json({ items: await listBackups(await scope(req)), policy: backupPolicy() })));

// Generates, stores, integrity-checks and restore-tests a backup of this restaurant's data. A failed backup is reported (422) but kept for the audit trail.
migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/backups', handle(async (req, res) => {
  const session = await scope(req); const who = await actor(req);
  const backup = await createBackup(session, who.id, ENGINE_VERSION);
  const ok = backup.status === 'VERIFIED';
  await logEvent(session, who.id, ok ? 'BACKUP_VERIFIED' : 'BACKUP_FAILED', ok ? 'Backup gerado e restauração de validação concluída.' : `Backup não validado: ${backup.error ?? 'falha desconhecida'}`, { backupId: backup.id, stage: backup.stage });
  await audit(session.tenantId, who.id, ok ? 'MIGRATION_BACKUP_VERIFIED' : 'MIGRATION_BACKUP_FAILED', session.id, { backupId: backup.id, stage: backup.stage });
  const { fileKey: _fileKey, ...visible } = backup;
  return res.status(ok ? 201 : 422).json(ok ? visible : { message: backup.error ?? 'Backup não validado.', backup: visible });
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/backups/:backupId/verify', handle(async (req, res) => {
  const session = await scope(req); const who = await actor(req);
  const backupId = uuid.safeParse(req.params.backupId); if (!backupId.success) throw new MigrationError('Identificador inválido.', 400);
  const backup = await reverifyBackup(session, backupId.data);
  const ok = backup.status === 'VERIFIED';
  await logEvent(session, who.id, ok ? 'BACKUP_VERIFIED' : 'BACKUP_FAILED', ok ? 'Backup revalidado (integridade e restauração).' : `Revalidação do backup falhou: ${backup.error ?? 'falha desconhecida'}`, { backupId: backup.id, stage: backup.stage });
  const { fileKey: _fileKey, ...visible } = backup;
  return res.status(ok ? 200 : 422).json(ok ? visible : { message: backup.error ?? 'Backup não validado.', backup: visible });
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/reopen', handle(async (req, res) => { const session = await scope(req); await reopenSession(session, req.auth!.userId); return res.json({ ok: true }); }));

const execute: Handler = async (req, res) => {
  const session = await scope(req);
  const body = z.object({ batchSize: z.number().int().min(1).max(1000).optional() }).parse(req.body ?? {});
  const who = await actor(req);
  // Registered synchronously so two concurrent requests cannot both pass the check; only the registrant clears it.
  if (running.has(session.id)) throw new MigrationError('Esta sessão já está em execução neste servidor.');
  running.add(session.id);
  let importable: number;
  try {
    // A fresh start re-checks that the validated backup is still intact on disk; resuming an interrupted run does not require a new one.
    if (session.status === 'APPROVED' && backupRequired()) await assertRecoverableBackup(session, { checkAge: false }).catch(async error => { if (!(error instanceof BackupError)) throw error; await logEvent(session, who.id, 'EXECUTION_BLOCKED', `Execução bloqueada: ${error.message}`); throw new MigrationError(`Execução bloqueada: ${error.message}`, 422); });
    importable = await prisma.migrationRecord.count({ where: { sessionId: session.id, approved: true, status: { in: ['VALID', 'DIVERGENT'] } } });
    await audit(session.tenantId, who.id, 'MIGRATION_EXECUTE_REQUESTED', session.id, { importable });
  } catch (error) { running.delete(session.id); throw error; }
  const run = runMigration(session, who, { batchSize: body.batchSize }).finally(() => running.delete(session.id));
  return respondWithRun(res, run, importable);
};
async function respondWithRun(res: Response, run: Promise<unknown>, importable: number) {
  if (importable > BACKGROUND_THRESHOLD) {
    // Large volumes run in the background; the panel polls the session. A rejected claim (wrong state) is surfaced before responding.
    const first = await Promise.race([run.then(() => 'done' as const, error => error as Error), new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 400))]);
    if (first instanceof Error) throw first;
    if (first === 'pending') { run.catch(error => console.error('Migration run failed:', error instanceof Error ? error.message : error)); return res.status(202).json({ status: 'RUNNING', message: 'Migração em andamento; acompanhe pelo painel.' }); }
  }
  return res.json(await run);
}
migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/execute', handle(execute));
migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/resume', handle(execute));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/cancel', handle(async (req, res) => {
  const session = await scope(req);
  if (!['DRAFT', 'ANALYZED', 'PREVIEWED', 'APPROVED', 'RUNNING', 'INTERRUPTED'].includes(session.status)) throw new MigrationError('A sessão não pode mais ser cancelada.');
  // A live run is stopped by the runner itself (it sets CANCELLED once the record in flight is done); only an abandoned RUNNING session is cancelled directly.
  const live = session.status === 'RUNNING' && Date.now() - session.updatedAt.getTime() < STALE_RUNNING_MS;
  if (live) await prisma.migrationSession.updateMany({ where: { id: session.id, status: 'RUNNING' }, data: { cancelRequested: true } });
  else await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'CANCELLED', finishedAt: new Date(), cancelRequested: false } });
  await logEvent(session, req.auth!.userId, 'CANCELLED', live ? 'Parada solicitada durante a execução; o registro em andamento termina antes de parar.' : 'Operação cancelada pelo operador.');
  await audit(session.tenantId, req.auth!.userId, 'MIGRATION_CANCELLED', session.id);
  return res.json({ ok: true, pending: live });
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/rollback', handle(async (req, res) => {
  const session = await scope(req);
  if (!z.object({ confirm: z.literal('REVERTER') }).safeParse(req.body).success) throw new MigrationError('Confirmação ausente: envie confirm = "REVERTER".', 422);
  return res.json(await rollbackSession(session, await actor(req)));
}));

migrationRoutes.post('/tenants/:tenantId/sessions/:sessionId/purge-files', handle(async (req, res) => {
  const session = await scope(req);
  if (!['COMPLETED', 'CANCELLED', 'ROLLED_BACK'].includes(session.status)) throw new MigrationError('Os arquivos só podem ser descartados depois do encerramento da migração.');
  const result = await prisma.migrationFile.updateMany({ where: { sessionId: session.id, content: { not: null } }, data: { content: null, purgedAt: new Date() } });
  await logEvent(session, req.auth!.userId, 'FILES_PURGED', `Conteúdo de ${result.count} arquivo(s) descartado (política de retenção).`);
  return res.json({ purged: result.count });
}));

const eventsQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(500), order: z.enum(['asc', 'desc']).default('asc'), type: z.string().trim().regex(/^[A-Z_]{1,40}$/).optional() });
// Audit timeline of one session: always scoped by session AND tenant, paginated (a long run writes one event per batch), with the acting user's name resolved.
migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/events', handle(async (req, res) => {
  const session = await scope(req);
  const query = eventsQuery.safeParse(req.query); if (!query.success) throw new MigrationError('Filtros ou paginação inválidos.', 400);
  const where = { sessionId: session.id, tenantId: session.tenantId, ...(query.data.type ? { type: query.data.type } : {}) };
  const [rows, total] = await Promise.all([
    prisma.migrationEvent.findMany({ where, orderBy: [{ createdAt: query.data.order }, { id: query.data.order }], skip: (query.data.page - 1) * query.data.pageSize, take: query.data.pageSize }),
    prisma.migrationEvent.count({ where }),
  ]);
  const actorIds = [...new Set(rows.flatMap(row => row.actorUserId ? [row.actorUserId] : []))];
  const names = new Map((actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : []).map(user => [user.id, user.name]));
  return res.json({ items: rows.map(row => ({ ...row, actorName: row.actorUserId ? names.get(row.actorUserId) ?? null : null })), total, page: query.data.page, pageSize: query.data.pageSize });
}));

migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/report', handle(async (req, res) => res.json(await buildReport(await scope(req)))));
migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/report.csv', handle(async (req, res) => {
  const session = await scope(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="migracao-${session.id.slice(0, 8)}.csv"`);
  const chunks: string[] = []; await streamCsv(session, chunk => chunks.push(chunk));
  return res.send(chunks.join(''));
}));
migrationRoutes.get('/tenants/:tenantId/sessions/:sessionId/report.pdf', handle(async (req, res) => {
  const session = await scope(req);
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="migracao-${session.id.slice(0, 8)}.pdf"`);
  return res.send(buildPdf(reportLines(await buildReport(session))));
}));
