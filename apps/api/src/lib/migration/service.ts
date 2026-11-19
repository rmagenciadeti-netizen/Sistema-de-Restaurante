import { Prisma, type MigrationBackup, type MigrationRecord, type MigrationSession } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prisma';
import { assertRecoverableBackup, BackupError, backupRequired } from './backup';
import { refineMappingWithAi, type AiCache } from './ai-assist';
import { signatureOfColumns, suggestMapping, structureSignature, tableKey, type MappingDocument } from './mapper';
import { phoneVariants } from './normalize';
import { evaluateFields, financialTotals, stageTablesDetailed, summarizeStaged, type Correction, type ExistingData, type Issue, type NormalizedValues } from './pipeline';
import { readSource, UnsupportedFileError, type SourceTable } from './readers';
import { ENTITIES, entryType, fieldForOutputKey, fieldOf, missingRequiredFields, outputKey, type EntityKey } from './targets';

export const ENGINE_VERSION = '1.0.0';
export class MigrationError extends Error { constructor(message: string, readonly status = 409, readonly details?: unknown) { super(message); } }

const EDITABLE = ['DRAFT', 'ANALYZED', 'PREVIEWED'];
const json = (value: unknown) => value as Prisma.InputJsonValue;

export async function logEvent(session: { id: string; tenantId: string }, actorUserId: string | null, type: string, message: string, data?: unknown, client: Prisma.TransactionClient | typeof prisma = prisma) {
  await client.migrationEvent.create({ data: { sessionId: session.id, tenantId: session.tenantId, actorUserId, type, message, data: data === undefined ? undefined : json(data) } });
}

export async function getSession(tenantId: string, sessionId: string): Promise<MigrationSession> {
  const session = await prisma.migrationSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) throw new MigrationError('Sessão de migração não encontrada para este restaurante.', 404);
  return session;
}
export const mappingOf = (session: Pick<MigrationSession, 'mapping'>) => (session.mapping ?? { tables: {}, relationships: [] }) as unknown as MappingDocument;

export async function loadTables(sessionId: string): Promise<{ tables: SourceTable[]; errors: { file: string; message: string; code: string }[]; files: { id: string; name: string; format: string; encoding: string; size: number; sha256: string; warnings: string[]; limitations: string[] }[] }> {
  const files = await prisma.migrationFile.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
  const tables: SourceTable[] = []; const errors: { file: string; message: string; code: string }[] = []; const info = [];
  for (const file of files) {
    if (!file.content) { errors.push({ file: file.name, message: 'Conteúdo do arquivo já foi descartado pela política de retenção.', code: 'purged' }); continue; }
    try {
      const result = readSource(file.name, Buffer.from(file.content));
      tables.push(...result.tables);
      info.push({ id: file.id, name: file.name, format: result.format, encoding: result.encoding, size: file.size, sha256: file.sha256, warnings: result.warnings, limitations: result.limitations });
    } catch (error) {
      errors.push({ file: file.name, message: error instanceof UnsupportedFileError ? error.message : 'Não foi possível ler o arquivo (corrompido ou formato inesperado).', code: error instanceof UnsupportedFileError ? error.code : 'corrupted' });
    }
  }
  return { tables, errors, files: info };
}

async function resetStaging(sessionId: string) { await prisma.migrationRecord.deleteMany({ where: { sessionId, status: { notIn: ['IMPORTED', 'REVERTED'] } } }); }

// ---- Analysis ----
export async function analyzeSession(session: MigrationSession, actorUserId: string, options: { useAi?: boolean } = {}) {
  if (!EDITABLE.includes(session.status)) throw new MigrationError('A análise só pode ser refeita antes da aprovação da execução.');
  const { tables, errors, files } = await loadTables(session.id);
  const fileInfo = await prisma.migrationFile.findMany({ where: { sessionId: session.id }, select: { id: true } });
  if (fileInfo.length === 0) throw new MigrationError('Envie ao menos um arquivo antes de analisar.', 422);
  await Promise.all(files.map(file => prisma.migrationFile.update({ where: { id: file.id }, data: { format: file.format } })));
  if (tables.length === 0) {
    const analysis = { files, errors, warnings: [], limitations: [], tables: [], analyzedAt: new Date().toISOString() };
    await prisma.migrationSession.update({ where: { id: session.id }, data: { analysis: json(analysis) } });
    await logEvent(session, actorUserId, 'ANALYSIS_FAILED', 'Nenhum arquivo legível foi encontrado.', { errors });
    throw new MigrationError(`Nenhum dado legível: ${errors.map(item => `${item.file}: ${item.message}`).join(' ') || 'arquivos vazios.'}`, 422, { errors });
  }
  const signatures = [...new Set(tables.map(structureSignature))];
  const templates = await prisma.migrationMappingTemplate.findMany({ where: { signature: { in: signatures } } });
  const lookup = new Map(templates.map(template => [`${template.signature}|${template.entity}`, template.columns as Record<string, string>]));
  const { mapping, profiles } = suggestMapping(tables, (signature, entity) => lookup.get(`${signature}|${entity}`) ?? null);
  let ai = { applied: 0, calls: 0, warnings: [] as string[] };
  let aiCache: AiCache = ((session.analysis as { aiCache?: AiCache } | null)?.aiCache) ?? {};
  if (options.useAi) { const refined = await refineMappingWithAi({ tables, mapping, profiles, cache: aiCache, gate: { tenantId: session.tenantId, unitId: null, userId: actorUserId } }); ai = refined; aiCache = refined.cache; }
  const analysis = {
    files, errors, analyzedAt: new Date().toISOString(), ai, aiCache,
    warnings: files.flatMap(file => file.warnings.map(message => `${file.name}: ${message}`)),
    limitations: [...new Set(files.flatMap(file => file.limitations))],
    tables: tables.map(table => ({
      key: tableKey(table), name: table.name, file: table.file, rowCount: table.rowCount, truncated: table.truncated, primaryKey: table.primaryKey ?? [],
      columns: table.columns.map(column => { const profile = profiles.get(`${tableKey(table)}::${column}`)!; return { name: column, type: table.types?.[column] ?? null, dominant: profile.dominant, samples: profile.samples, nullRatio: Math.round(profile.nullRatio * 100) / 100, uniqueRatio: Math.round(profile.uniqueRatio * 100) / 100 }; }),
    })),
  };
  await resetStaging(session.id);
  await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'ANALYZED', analysis: json(analysis), mapping: json(mapping), summary: Prisma.JsonNull, outcome: null } });
  await logEvent(session, actorUserId, 'ANALYZED', `Análise concluída: ${tables.length} tabela(s), ${tables.reduce((sum, table) => sum + table.rowCount, 0)} linha(s).`, { tables: tables.length, errors: errors.length, ai });
  return { analysis: { ...analysis, aiCache: undefined }, mapping };
}

// ---- Mapping review ----
export const mappingInput = z.object({ tables: z.record(z.string().max(500), z.object({
  entity: z.enum(['CATEGORY', 'PRODUCT', 'CUSTOMER', 'SUPPLIER', 'FIN_CATEGORY', 'COST_CENTER', 'BANK_ACCOUNT', 'PAYABLE', 'RECEIVABLE', 'EMPLOYEE', 'SALE', 'SALE_ITEM', 'IGNORE']).optional(),
  columns: z.record(z.string().max(300), z.string().max(60).nullable()).optional(),
  approved: z.boolean().optional(),
})) });

export async function updateMapping(session: MigrationSession, actorUserId: string, input: z.infer<typeof mappingInput>) {
  if (!EDITABLE.includes(session.status) || !session.mapping) throw new MigrationError('O mapeamento só pode ser alterado depois da análise e antes da aprovação da execução.');
  const mapping = mappingOf(session); const changes: string[] = [];
  const analysis = session.analysis as { tables?: { key: string; columns: { name: string }[] }[] } | null;
  for (const [key, change] of Object.entries(input.tables)) {
    const table = mapping.tables[key]; if (!table) throw new MigrationError(`Tabela desconhecida: ${key}`, 422);
    if (change.entity && change.entity !== table.entity) { table.entity = change.entity as EntityKey | 'IGNORE'; table.entityReason = 'Definido pelo operador.'; for (const column of Object.values(table.columns)) if (column.source !== 'operator') { column.target = null; column.confidence = 0; column.level = 'none'; column.reason = 'Entidade alterada pelo operador; refaça a associação.'; } changes.push(`${table.name}: entidade ${change.entity}`); }
    for (const [column, target] of Object.entries(change.columns ?? {})) {
      if (!table.columns[column]) throw new MigrationError(`Coluna desconhecida "${column}" em ${table.name}.`, 422);
      if (target !== null && (table.entity === 'IGNORE' || !fieldOf(table.entity, target))) throw new MigrationError(`Campo "${target}" não existe em ${table.entity === 'IGNORE' ? 'tabela ignorada' : ENTITIES[table.entity].label}.`, 422);
      table.columns[column] = { target, confidence: target ? 1 : 0, level: target ? 'direct' : 'none', reason: target ? 'Definido pelo operador.' : 'Removido pelo operador.', source: 'operator', needsReview: false };
      changes.push(`${table.name}.${column} → ${target ?? '—'}`);
    }
    const targets = Object.values(table.columns).map(column => column.target).filter(Boolean);
    if (new Set(targets).size !== targets.length) throw new MigrationError(`Dois campos de origem apontam para o mesmo campo de destino em ${table.name}.`, 422);
    table.missingRequired = table.entity === 'IGNORE' ? [] : missingRequiredFields(table.entity, targets as string[]);
    if (change.approved !== undefined) {
      if (change.approved && table.entity !== 'IGNORE' && table.missingRequired.length > 0) throw new MigrationError(`Mapeie os campos obrigatórios de ${table.name}: ${table.missingRequired.join(', ')}.`, 422);
      table.approved = change.approved;
      const names = analysis?.tables?.find(item => item.key === key)?.columns.map(item => item.name);
      if (change.approved && table.entity !== 'IGNORE' && names) {
        const columns = Object.fromEntries(Object.entries(table.columns).filter(([, mapped]) => mapped.target).map(([name, mapped]) => [name, mapped.target as string]));
        await prisma.migrationMappingTemplate.upsert({ where: { signature_entity: { signature: signatureOfColumns(names), entity: table.entity } }, create: { signature: signatureOfColumns(names), entity: table.entity, columns: columns, createdById: actorUserId, timesUsed: 1 }, update: { columns, timesUsed: { increment: 1 } } });
      }
      changes.push(`${table.name}: ${change.approved ? 'mapeamento aprovado' : 'aprovação removida'}`);
    }
  }
  await resetStaging(session.id);
  await prisma.migrationSession.update({ where: { id: session.id }, data: { mapping: json(mapping), status: 'ANALYZED', summary: Prisma.JsonNull } });
  await logEvent(session, actorUserId, 'MAPPING_UPDATED', `Mapeamento revisado pelo operador (${changes.length} alteração(ões)).`, { changes });
  return mapping;
}

// ---- Preview (staging) ----
export async function loadExisting(tenantId: string): Promise<ExistingData> {
  const [employees, sales, categories, products, customers, suppliers, finCategories, costCenters, bankAccounts, entries] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId }, select: { cpf: true, fullName: true } }),
    prisma.order.findMany({ where: { tenantId, code: { startsWith: 'MIG-' } }, select: { code: true } }),
    prisma.productCategory.findMany({ where: { tenantId }, select: { name: true } }),
    prisma.product.findMany({ where: { tenantId }, select: { code: true, barcode: true, name: true, price: true } }),
    prisma.customer.findMany({ where: { tenantId }, select: { phone: true, document: true, name: true } }),
    prisma.supplier.findMany({ where: { tenantId }, select: { name: true, document: true } }),
    prisma.financialCategory.findMany({ where: { tenantId }, select: { type: true, name: true } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { name: true } }),
    prisma.bankAccount.findMany({ where: { tenantId }, select: { name: true } }),
    prisma.financialEntry.findMany({ where: { tenantId }, select: { type: true, documentNumber: true, description: true, dueAt: true, amount: true, installmentNumber: true, debtorName: true, supplier: { select: { name: true } }, customer: { select: { name: true } } }, take: 200_000 }),
  ]);
  return {
    employees, saleNumbers: sales.map(sale => sale.code.slice(4)), categories, products: products.map(product => ({ ...product, price: product.price.toString() })), customers, suppliers, finCategories, costCenters, bankAccounts,
    entries: entries.map(entry => ({ type: entry.type, documentNumber: entry.documentNumber, description: entry.description, dueAt: entry.dueAt ? entry.dueAt.toISOString().slice(0, 10) : null, amount: entry.amount.toString(), installmentNumber: entry.installmentNumber, party: entry.supplier?.name ?? entry.customer?.name ?? entry.debtorName ?? '' })),
  };
}

const BATCH_SIZE = 200;
export async function previewSession(session: MigrationSession, actorUserId: string) {
  if (!['ANALYZED', 'PREVIEWED'].includes(session.status)) throw new MigrationError('Analise o arquivo e aprove o mapeamento antes da pré-visualização.');
  const mapping = mappingOf(session);
  if (!Object.values(mapping.tables).some(table => table.approved && table.entity !== 'IGNORE')) throw new MigrationError('Aprove o mapeamento de ao menos uma tabela antes de gerar a pré-visualização.', 422);
  const { tables } = await loadTables(session.id);
  const { records, stats } = stageTablesDetailed(tables, mapping, await loadExisting(session.tenantId));
  await resetStaging(session.id);
  for (let start = 0; start < records.length; start += 500) {
    await prisma.migrationRecord.createMany({ data: records.slice(start, start + 500).map(record => ({
      sessionId: session.id, tenantId: session.tenantId, entity: record.entity, tableName: record.tableName, rowIndex: record.rowIndex, seq: record.seq, sourceKey: record.sourceKey?.slice(0, 200) ?? null,
      status: record.status, original: json(record.original), normalized: json(record.normalized), corrections: json(record.corrections), issues: json(record.issues), approved: record.approved,
    })) });
  }
  const staged = summarizeStaged(records);
  const importable = records.filter(record => record.approved).length;
  const mappedTables = Object.values(mapping.tables).filter(table => table.approved && table.entity !== 'IGNORE');
  const summary = {
    generatedAt: new Date().toISOString(), tablesFound: Object.keys(mapping.tables).length, tablesMapped: mappedTables.length,
    rowsByTable: tables.map(table => ({ table: table.name, rows: table.rowCount, entity: mapping.tables[tableKey(table)]?.entity ?? 'IGNORE' })),
    fieldsRecognised: mappedTables.reduce((sum, table) => sum + Object.values(table.columns).filter(column => column.target).length, 0),
    fieldsWithoutMatch: Object.values(mapping.tables).reduce((sum, table) => sum + Object.values(table.columns).filter(column => !column.target).length, 0),
    ...staged, refs: stats.refs, installments: stats.installments,
    financial: financialTotals(records.filter(record => record.approved)),
    importable, ignored: records.filter(record => ['DUPLICATE', 'REJECTED'].includes(record.status)).length,
    pendingReview: records.filter(record => record.status === 'DIVERGENT' && !record.approved).length,
    estimate: { batches: Math.ceil(importable / BATCH_SIZE), seconds: Math.ceil(importable / 120) },
    alerts: [
      ...stats.alerts,
      ...Object.values(mapping.tables).filter(table => table.entity !== 'IGNORE' && !table.approved).map(table => `Tabela "${table.name}" não aprovada: não entra na importação.`),
      ...Object.values(mapping.tables).filter(table => table.entity === 'IGNORE').map(table => `Tabela "${table.name}" não reconhecida: ignorada.`),
    ],
  };
  await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'PREVIEWED', summary: json(summary), outcome: null } });
  await logEvent(session, actorUserId, 'PREVIEWED', `Pré-visualização gerada: ${records.length} registro(s), ${importable} importável(is).`, { byEntity: staged.byEntity });
  return summary;
}

export async function refreshSummary(sessionId: string, options: { financial?: boolean } = {}) {
  const session = await prisma.migrationSession.findUniqueOrThrow({ where: { id: sessionId } });
  const grouped = await prisma.migrationRecord.groupBy({ by: ['entity', 'status', 'approved'], where: { sessionId }, _count: true });
  const byEntity: Record<string, Record<string, number>> = {};
  let importable = 0; let pendingReview = 0;
  for (const row of grouped) {
    const bucket = byEntity[row.entity] ?? (byEntity[row.entity] = {});
    bucket[row.status] = (bucket[row.status] ?? 0) + row._count; bucket.total = (bucket.total ?? 0) + row._count;
    if (row.approved && ['VALID', 'DIVERGENT'].includes(row.status)) importable += row._count;
    if (row.status === 'DIVERGENT' && !row.approved) pendingReview += row._count;
  }
  const financial = options.financial ? { financial: await recomputeFinancial(sessionId) } : {};
  const summary = { ...((session.summary as object | null) ?? {}), byEntity, importable, pendingReview, ...financial };
  await prisma.migrationSession.update({ where: { id: sessionId }, data: { summary: json(summary) } });
  return summary;
}

// Totals of what is (or was) going to be written: approved records plus those already imported.
export async function recomputeFinancial(sessionId: string) {
  const rows: { entity: string; normalized: unknown }[] = []; let cursor: string | undefined;
  for (;;) {
    const page = await prisma.migrationRecord.findMany({ where: { sessionId, entity: { in: ['PAYABLE', 'RECEIVABLE', 'BANK_ACCOUNT'] }, OR: [{ approved: true, status: { in: ['VALID', 'DIVERGENT'] } }, { status: 'IMPORTED' }] }, orderBy: { id: 'asc' }, take: 2000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, entity: true, normalized: true } });
    if (page.length === 0) break;
    rows.push(...page); cursor = page[page.length - 1].id; if (page.length < 2000) break;
  }
  return financialTotals(rows);
}

// ---- Manual review of a staged record ----
export const recordPatch = z.object({
  values: z.record(z.string().max(60), z.string().max(2000).nullable()).optional(),
  approve: z.boolean().optional(),
  ignore: z.boolean().optional(),
}).refine(value => value.values !== undefined || value.approve !== undefined || value.ignore !== undefined, 'Nada a alterar');

const stringify = (values: NormalizedValues) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : String(value)]));
export async function existingEntry(tenantId: string, entity: 'PAYABLE' | 'RECEIVABLE', values: NormalizedValues) {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : null;
  const party = text('supplierName') ?? text('customerName');
  const document = text('documentNumber');
  const where: Prisma.FinancialEntryWhereInput = { tenantId, type: entryType(entity), ...(document
    ? { documentNumber: { equals: document, mode: 'insensitive' }, installmentNumber: text('installmentNumber') ? Number(text('installmentNumber')) : null }
    : { description: { equals: text('description') ?? '', mode: 'insensitive' }, amount: new Prisma.Decimal(text('amount') ?? 0), dueAt: text('dueAt') ? new Date(`${text('dueAt')}T12:00:00.000Z`) : null, installmentNumber: text('installmentNumber') ? Number(text('installmentNumber')) : null }),
    ...(party ? { OR: [{ supplier: { name: { equals: party, mode: 'insensitive' } } }, { customer: { name: { equals: party, mode: 'insensitive' } } }, { debtorName: { equals: party, mode: 'insensitive' } }] } : {}) };
  return prisma.financialEntry.findFirst({ where, select: { id: true } });
}

// Historical sales keep the number they had in the old system under a recognisable prefix.
export const saleCode = (number: string) => `MIG-${number}`.slice(0, 60);

export async function existsInTenant(tenantId: string, entity: EntityKey, values: NormalizedValues): Promise<boolean> {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : null;
  const byName = (name: string | null) => name ? { equals: name, mode: 'insensitive' as const } : undefined;
  switch (entity) {
    case 'CATEGORY': return text('name') ? Boolean(await prisma.productCategory.findFirst({ where: { tenantId, name: byName(text('name')) }, select: { id: true } })) : false;
    case 'FIN_CATEGORY': return text('name') && text('type') ? Boolean(await prisma.financialCategory.findFirst({ where: { tenantId, type: text('type') as 'INCOME' | 'EXPENSE', name: byName(text('name')) }, select: { id: true } })) : false;
    case 'COST_CENTER': return text('name') ? Boolean(await prisma.costCenter.findFirst({ where: { tenantId, name: byName(text('name')) }, select: { id: true } })) : false;
    case 'BANK_ACCOUNT': return text('name') ? Boolean(await prisma.bankAccount.findFirst({ where: { tenantId, name: byName(text('name')) }, select: { id: true } })) : false;
    case 'PRODUCT': return Boolean((text('code') || text('barcode')) && await prisma.product.findFirst({ where: { tenantId, OR: [...(text('code') ? [{ code: text('code')! }] : []), ...(text('barcode') ? [{ barcode: text('barcode')! }] : [])] }, select: { id: true } }));
    case 'CUSTOMER': return Boolean((text('phone') || text('document')) && await prisma.customer.findFirst({ where: { tenantId, OR: [...(text('phone') ? [{ phone: { in: phoneVariants(text('phone')!) } }] : []), ...(text('document') ? [{ document: text('document')! }] : [])] }, select: { id: true } }));
    case 'SUPPLIER': return Boolean((text('name') || text('document')) && await prisma.supplier.findFirst({ where: { tenantId, OR: [...(text('name') ? [{ name: byName(text('name')) }] : []), ...(text('document') ? [{ document: text('document')! }] : [])] }, select: { id: true } }));
    case 'PAYABLE': case 'RECEIVABLE': return Boolean(await existingEntry(tenantId, entity, values));
    case 'EMPLOYEE': return Boolean((text('cpf') || text('fullName')) && await prisma.employee.findFirst({ where: { tenantId, OR: [...(text('cpf') ? [{ cpf: text('cpf')! }] : []), ...(text('fullName') ? [{ fullName: byName(text('fullName')) }] : [])] }, select: { id: true } }));
    case 'SALE': return text('saleNumber') ? Boolean(await prisma.order.findFirst({ where: { tenantId, code: saleCode(text('saleNumber')!) }, select: { id: true } })) : false;
    case 'SALE_ITEM': return false;
  }
}

export async function reviewRecord(session: MigrationSession, record: MigrationRecord, actorUserId: string, actorLabel: string, patch: z.infer<typeof recordPatch>) {
  if (session.status !== 'PREVIEWED') throw new MigrationError('Registros só podem ser revisados na etapa de pré-visualização (reabra a sessão se necessário).');
  if (['IMPORTED', 'REVERTED'].includes(record.status)) throw new MigrationError('Registro já importado; use a reversão da migração.');
  const entity = record.entity as EntityKey;
  let normalized = record.normalized as NormalizedValues; let corrections = (record.corrections ?? []) as unknown as Correction[]; let issues = (record.issues ?? []) as unknown as Issue[];
  let status = record.status; let approved = record.approved;
  if (patch.values) {
    const raw: Record<string, string | null> = {}; const previous = stringify(normalized);
    for (const field of ENTITIES[entity].fields) { const key = outputKey(field); if (key in previous) raw[field.key] = previous[key]; }
    for (const [key, value] of Object.entries(patch.values)) { const field = fieldForOutputKey(entity, key) ?? fieldOf(entity, key); if (!field) throw new MigrationError(`Campo inexistente: ${key}`, 422); raw[field.key] = value; }
    const edited = new Set(Object.keys(patch.values));
    const evaluated = evaluateFields(entity, raw);
    const manual: Correction[] = Object.entries(patch.values).map(([key, value]) => ({ field: key, original: stringify(normalized)[key] ?? null, corrected: value, rule: 'manual', reason: `Corrigido manualmente por ${actorLabel}.`, actor: actorUserId }));
    // Reference extras survive unless the reference itself was edited; unresolved/ambiguous reference decisions stay with the record.
    const staleExtras = [...(edited.has('supplierName') ? ['supplierDocument'] : []), ...(edited.has('customerName') ? ['customerPhone', 'customerDocument'] : [])];
    const extras = Object.fromEntries(Object.entries(normalized).filter(([key]) => ['supplierDocument', 'customerPhone', 'customerDocument'].includes(key) && !staleExtras.includes(key)));
    const keptReferenceIssues = issues.filter(issue => ['unresolved_reference', 'ambiguous_reference'].includes(issue.code) && !edited.has(issue.field));
    normalized = { ...extras, ...evaluated.normalized }; corrections = [...corrections, ...evaluated.corrections, ...manual]; issues = [...evaluated.issues, ...keptReferenceIssues];
    status = issues.some(issue => issue.severity === 'error') ? 'REJECTED' : issues.some(issue => issue.severity === 'review') ? 'DIVERGENT' : 'VALID';
    if (status !== 'REJECTED' && await existsInTenant(session.tenantId, entity, normalized)) { status = 'DUPLICATE'; issues.push({ field: 'key', severity: 'info', code: 'exists', message: 'Já existe no RM Restaurant um registro com esta chave.' }); }
    approved = status === 'VALID';
  }
  if (patch.ignore === true) { status = 'IGNORED'; approved = false; issues = [...issues, { field: 'record', severity: 'info', code: 'ignored_by_operator', message: `Ignorado pelo operador ${actorLabel}.` }]; }
  else if (patch.ignore === false && status === 'IGNORED') { status = issues.some(issue => issue.severity === 'error') ? 'REJECTED' : issues.some(issue => issue.severity === 'review') ? 'DIVERGENT' : 'VALID'; approved = status === 'VALID'; }
  if (patch.approve !== undefined) {
    if (patch.approve && !['DIVERGENT', 'VALID'].includes(status)) throw new MigrationError('Somente registros válidos ou com divergência a revisar podem ser aprovados; corrija os erros ou ignore o registro.', 422);
    approved = patch.approve;
  }
  const updated = await prisma.migrationRecord.update({ where: { id: record.id }, data: { normalized: json(normalized), corrections: json(corrections), issues: json(issues), status, approved } });
  await logEvent(session, actorUserId, 'RECORD_REVIEWED', `Registro ${record.tableName}#${record.rowIndex + 2} revisado por ${actorLabel}.`, { recordId: record.id, patch, status, approved });
  await refreshSummary(session.id, { financial: true });
  return updated;
}

export { backupRequired };

// Authorization is released only for a backup the platform itself generated, stored and restore-tested for THIS restaurant and session (see backup.ts).
// An operator's statement that "a backup exists" is not accepted: the platform cannot verify it, so it cannot prove recoverability.
export async function approveExecution(session: MigrationSession, actorUserId: string, actorLabel: string) {
  if (session.status !== 'PREVIEWED') throw new MigrationError('Gere a pré-visualização antes de aprovar a execução.');
  const importable = await prisma.migrationRecord.count({ where: { sessionId: session.id, approved: true, status: { in: ['VALID', 'DIVERGENT'] } } });
  if (importable === 0) throw new MigrationError('Não há registros aprovados para importar.', 422);
  let backup: MigrationBackup | null = null;
  try { backup = await assertRecoverableBackup(session); }
  catch (error) {
    if (!(error instanceof BackupError)) throw error;
    // Outside production a backup is optional, but a failing one is never silently attached.
    if (backupRequired()) { await logEvent(session, actorUserId, 'APPROVAL_BLOCKED', `Autorização bloqueada: ${error.message}`); throw new MigrationError(`Autorização bloqueada: ${error.message}`, 422); }
  }
  const updated = await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'APPROVED', approvedById: actorUserId, approvedAt: new Date(), ...(backup ? { backupConfirmedAt: backup.verifiedAt, backupReference: `rmbk:${backup.id} sha256:${backup.sha256?.slice(0, 16)}`, backupConfirmedById: backup.createdById } : {}) } });
  await logEvent(session, actorUserId, 'APPROVED', `Execução autorizada explicitamente por ${actorLabel} (${importable} registro(s)).`, { importable, backupId: backup?.id ?? null, backupVerifiedAt: backup?.verifiedAt ?? null });
  return updated;
}

export async function reopenSession(session: MigrationSession, actorUserId: string) {
  if (session.status !== 'APPROVED') throw new MigrationError('Somente uma execução aprovada e ainda não iniciada pode ser reaberta.');
  await prisma.migrationSession.update({ where: { id: session.id }, data: { status: 'PREVIEWED', approvedAt: null, approvedById: null } });
  await logEvent(session, actorUserId, 'REOPENED', 'Aprovação revogada; sessão voltou para a pré-visualização.');
}
