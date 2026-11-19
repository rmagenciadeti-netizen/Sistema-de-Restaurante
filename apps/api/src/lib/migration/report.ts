import type { MigrationSession } from '@prisma/client';
import { prisma } from '../prisma';
import { OUTCOME_LABEL, type Validation } from './executor';
import type { Correction, Issue } from './pipeline';
import { ENTITIES, GROUPS, type EntityKey } from './targets';
import { recomputeFinancial } from './service';
import type { FinancialTotals } from './pipeline';
import type { MappingDocument } from './mapper';
import { ENGINE_VERSION } from './service';

const STATUS_LABEL: Record<string, string> = { VALID: 'Válido', DIVERGENT: 'Divergente', DUPLICATE: 'Duplicado', REJECTED: 'Rejeitado', IGNORED: 'Ignorado', IMPORTED: 'Importado', FAILED: 'Falhou', REVERTED: 'Revertido' };
export const SESSION_STATUS_LABEL: Record<string, string> = { DRAFT: 'Rascunho', ANALYZED: 'Analisada', PREVIEWED: 'Pré-visualizada', APPROVED: 'Aprovada', RUNNING: 'Em execução', COMPLETED: 'Concluída', INTERRUPTED: 'Interrompida', CANCELLED: 'Cancelada', ROLLING_BACK: 'Em reversão', ROLLED_BACK: 'Revertida' };

export async function buildReport(session: MigrationSession) {
  // Financial totals of what was actually written once the run is over; before that, of what is approved to be written.
  const financial = await recomputeFinancial(session.id);
  const [tenant, operator, approver, files, grouped, started, backupRows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { name: true, slug: true } }),
    session.createdById ? prisma.user.findUnique({ where: { id: session.createdById }, select: { name: true, email: true } }) : null,
    session.approvedById ? prisma.user.findUnique({ where: { id: session.approvedById }, select: { name: true } }) : null,
    prisma.migrationFile.findMany({ where: { sessionId: session.id }, select: { name: true, size: true, sha256: true, format: true, purgedAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.migrationRecord.groupBy({ by: ['entity', 'status'], where: { sessionId: session.id }, _count: true }),
    prisma.migrationEvent.findFirst({ where: { sessionId: session.id, tenantId: session.tenantId, type: 'STARTED' }, orderBy: { createdAt: 'asc' }, select: { actorUserId: true } }),
    prisma.migrationBackup.findMany({ where: { sessionId: session.id, tenantId: session.tenantId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, stage: true, createdAt: true, verifiedAt: true, sha256: true, fileSize: true, encrypted: true, error: true, verification: true, database: true, createdById: true } }),
  ]);
  const executor = started?.actorUserId ? await prisma.user.findUnique({ where: { id: started.actorUserId }, select: { name: true } }) : null;
  // Evidence only: a backup counts as restore-tested when its stored verification says so; the storage path is never exposed.
  const backups = backupRows.map(({ verification, database, ...row }) => ({ ...row, restoreVerified: (verification as { restore?: { ok?: boolean } } | null)?.restore?.ok === true, database: (database as { name?: string } | null)?.name ?? null }));
  const mapping = (session.mapping ?? { tables: {}, relationships: [] }) as unknown as MappingDocument;
  const analysis = (session.analysis ?? {}) as { errors?: { file: string; message: string }[]; warnings?: string[]; limitations?: string[]; tables?: { name: string; rowCount: number }[]; ai?: { applied: number; calls: number } };
  const validation = (session.validation ?? null) as Validation | null;
  const byEntity: Record<string, Record<string, number>> = {};
  for (const row of grouped) { const bucket = byEntity[row.entity] ?? (byEntity[row.entity] = {}); bucket[row.status] = row._count; bucket.total = (bucket.total ?? 0) + row._count; }

  const rules: Record<string, number> = {}; const sample: (Correction & { entity: string; table: string; row: number })[] = []; let corrections = 0; let truncated = false;
  const pendencies: { entity: string; table: string; row: number; status: string; messages: string[] }[] = []; const errors: typeof pendencies = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const rows = await prisma.migrationRecord.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, entity: true, tableName: true, rowIndex: true, status: true, corrections: true, issues: true, error: true, approved: true } });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id; if (page === 49 && rows.length === 1000) truncated = true;
    for (const row of rows) {
      for (const correction of (row.corrections ?? []) as unknown as Correction[]) { corrections++; rules[correction.rule] = (rules[correction.rule] ?? 0) + 1; if (sample.length < 100) sample.push({ ...correction, entity: row.entity, table: row.tableName, row: row.rowIndex + 2 }); }
      const messages = ((row.issues ?? []) as unknown as Issue[]).filter(issue => issue.severity !== 'info').map(issue => issue.message);
      const entry = { entity: row.entity, table: row.tableName, row: row.rowIndex + 2, status: row.status, messages: row.error ? [...messages, row.error] : messages };
      if (row.status === 'FAILED') { if (errors.length < 200) errors.push(entry); }
      else if (['REJECTED', 'DIVERGENT'].includes(row.status) && !(row.status === 'DIVERGENT' && row.approved) && pendencies.length < 500) pendencies.push(entry);
    }
    if (rows.length < 1000) break;
  }
  const durationSeconds = session.startedAt && session.finishedAt ? Math.round((session.finishedAt.getTime() - session.startedAt.getTime()) / 1000) : null;
  const comparison = (Object.keys(byEntity) as EntityKey[]).sort((a, b) => (ENTITIES[a]?.order ?? 99) - (ENTITIES[b]?.order ?? 99)).map(entity => ({
    entity, label: ENTITIES[entity]?.label ?? entity, read: byEntity[entity].total ?? 0, imported: byEntity[entity].IMPORTED ?? 0, duplicates: byEntity[entity].DUPLICATE ?? 0, rejected: byEntity[entity].REJECTED ?? 0,
    failed: byEntity[entity].FAILED ?? 0, ignored: byEntity[entity].IGNORED ?? 0, pending: (byEntity[entity].DIVERGENT ?? 0) + (byEntity[entity].VALID ?? 0), reverted: byEntity[entity].REVERTED ?? 0,
  }));
  const totals = comparison.reduce((sum, item) => ({ read: sum.read + item.read, imported: sum.imported + item.imported, duplicates: sum.duplicates + item.duplicates, rejected: sum.rejected + item.rejected, failed: sum.failed + item.failed, ignored: sum.ignored + item.ignored, pending: sum.pending + item.pending }), { read: 0, imported: 0, duplicates: 0, rejected: 0, failed: 0, ignored: 0, pending: 0 });
  return {
    generatedAt: new Date().toISOString(), engineVersion: ENGINE_VERSION,
    identification: { backupReference: session.backupReference, backupConfirmedAt: session.backupConfirmedAt, migrationId: session.id, restaurant: tenant?.name ?? '—', restaurantSlug: tenant?.slug ?? null, label: session.label, operator: operator?.name ?? null, executedBy: executor?.name ?? null, approvedBy: approver?.name ?? null, approvedAt: session.approvedAt, createdAt: session.createdAt, startedAt: session.startedAt, finishedAt: session.finishedAt, sourceSystem: session.sourceUnknown ? 'Desconhecido' : session.sourceSystem ?? 'Não informado', files },
    analysis: {
      tables: Object.values(mapping.tables).map(table => ({ name: table.name, entity: table.entity, approved: table.approved, rows: analysis.tables?.find(item => item.name === table.name)?.rowCount ?? 0, mapped: Object.entries(table.columns).filter(([, column]) => column.target).map(([name, column]) => ({ column: name, target: column.target, confidence: column.confidence, source: column.source })), unmapped: Object.entries(table.columns).filter(([, column]) => !column.target).map(([name]) => name) })),
      relationships: mapping.relationships, unreadableFiles: analysis.errors ?? [], warnings: analysis.warnings ?? [], limitations: analysis.limitations ?? [], ai: analysis.ai ?? null,
    },
    corrections: { total: corrections, byRule: rules, sample, truncated },
    groups: GROUPS.map(group => ({ key: group.key, label: group.label, ...comparison.filter(item => group.entities.includes(item.entity)).reduce((sum, item) => ({ read: sum.read + item.read, imported: sum.imported + item.imported, duplicates: sum.duplicates + item.duplicates, rejected: sum.rejected + item.rejected, failed: sum.failed + item.failed, ignored: sum.ignored + item.ignored, pending: sum.pending + item.pending }), { read: 0, imported: 0, duplicates: 0, rejected: 0, failed: 0, ignored: 0, pending: 0 }) })),
    financial: financial as FinancialTotals, backups,
    result: { totals, durationSeconds }, comparison, pendencies, errors,
    alerts: [...(validation?.alerts ?? []), ...(truncated ? ['Relatório limitado aos primeiros 50.000 registros; use a exportação CSV.'] : [])],
    integrity: validation?.checks ?? [],
    overall: { status: session.status, statusLabel: SESSION_STATUS_LABEL[session.status] ?? session.status, outcome: session.outcome, outcomeLabel: session.outcome ? OUTCOME_LABEL[session.outcome] ?? session.outcome : 'Ainda não executada' },
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;

// ---- CSV ----
// Cells that spreadsheets would execute as formulas are neutralised: the data comes from an untrusted source system.
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export async function streamCsv(session: MigrationSession, write: (chunk: string) => void) {
  const header = ['grupo', 'entidade', 'tabela_origem', 'linha_origem', 'chave_origem', 'situacao', 'id_destino', 'nome_ou_descricao', 'valor', 'vencimento', 'situacao_financeira', 'campo', 'valor_original', 'valor_corrigido', 'regra', 'motivo', 'ocorrencia'];
  write(`\ufeff${header.join(';')}\r\n`);
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.migrationRecord.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const values = (row.normalized ?? {}) as Record<string, unknown>;
      const group = GROUPS.find(item => item.entities.includes(row.entity as EntityKey))?.label ?? '';
      const base = [group, row.entity, row.tableName, row.rowIndex + 2, row.sourceKey, STATUS_LABEL[row.status] ?? row.status, row.targetId, values.name ?? values.description ?? '', values.amount ?? values.price ?? values.initialBalance ?? '', values.dueAt ?? '', values.status ?? ''];
      const lines: unknown[][] = [];
      for (const correction of (row.corrections ?? []) as unknown as Correction[]) lines.push([...base, correction.field, correction.original, correction.corrected, correction.rule, correction.reason, '']);
      for (const issue of (row.issues ?? []) as unknown as Issue[]) lines.push([...base, issue.field, '', '', issue.code, '', issue.message]);
      if (row.error) lines.push([...base, '', '', '', 'error', '', row.error]);
      if (lines.length === 0) lines.push([...base, '', '', '', '', '', '']);
      write(lines.map(line => line.map(csvCell).join(';')).join('\r\n') + '\r\n');
    }
    if (rows.length < 1000) break;
  }
}

// ---- PDF (plain text report; no external dependency) ----
const latin1 = (text: string) => text.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
export function buildPdf(lines: string[]): Buffer {
  const perPage = 60; const wrapped = lines.flatMap(line => line.length <= 100 ? [line] : (line.match(/.{1,100}(\s|$)/g) ?? [line]).map(part => part.trimEnd()));
  const pages = Array.from({ length: Math.max(1, Math.ceil(wrapped.length / perPage)) }, (_, index) => wrapped.slice(index * perPage, (index + 1) * perPage));
  const objects: Buffer[] = []; const add = (body: string | Buffer) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, index) => {
    const stream = Buffer.from(`BT /F1 9 Tf 40 802 Td 12 TL ${page.map(line => `(${latin1(line)}) Tj T*`).join(' ')} ET`, 'latin1');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`);
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
  });
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]; const offsets: number[] = []; let position = parts[0].length;
  objects.forEach((body, index) => { offsets.push(position); const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]); parts.push(chunk); position += chunk.length; });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

export function reportLines(report: Report): string[] {
  const id = report.identification; const date = (value: unknown) => value ? new Date(value as string).toLocaleString('pt-BR') : '—';
  const lines: string[] = [
    'RM SMART MIGRATION - RELATORIO DE MIGRACAO DE DADOS', '', '1. RESUMO EXECUTIVO',
    `Restaurante: ${id.restaurant}`, `Migracao: ${id.migrationId}`, `Operador: ${id.operator ?? '—'}   Aprovada por: ${id.approvedBy ?? '—'}   Executada por: ${id.executedBy ?? '—'}`,
    `Origem: ${id.sourceSystem}   Motor: v${report.engineVersion}`, `Backup informado: ${id.backupReference ?? 'nao informado'}`, `Criada em: ${date(id.createdAt)}   Finalizada em: ${date(id.finishedAt)}`,
    `Situacao geral: ${report.overall.outcomeLabel} (${report.overall.statusLabel})`,
    `Registros lidos: ${report.result.totals.read}  Importados: ${report.result.totals.imported}  Duplicados: ${report.result.totals.duplicates}  Rejeitados: ${report.result.totals.rejected}  Falhas: ${report.result.totals.failed}  Ignorados: ${report.result.totals.ignored}  Pendentes: ${report.result.totals.pending}`,
    '', '2. RESULTADO POR MODULO / COMPARACAO ORIGEM x DESTINO',
    ...report.comparison.map(item => `${item.label}: origem ${item.read} -> importados ${item.imported}, duplicados ${item.duplicates}, rejeitados ${item.rejected}, falhas ${item.failed}, ignorados ${item.ignored}, pendentes ${item.pending}, revertidos ${item.reverted}`),
    '', 'GRUPOS DE DADOS', ...report.groups.map(group => `${group.label}: origem ${group.read} -> importados ${group.imported}, duplicados ${group.duplicates}, rejeitados ${group.rejected}, falhas ${group.failed}, pendentes ${group.pending}`),
    '', 'VALORES FINANCEIROS (importados / aprovados)',
    `Contas a pagar: ${report.financial.payable.count} lancamentos, original R$ ${report.financial.payable.amount}, pago R$ ${report.financial.payable.paid}, em aberto R$ ${report.financial.payable.open}, vencidos ${report.financial.payable.overdue}`,
    `Contas a receber: ${report.financial.receivable.count} lancamentos, original R$ ${report.financial.receivable.amount}, recebido R$ ${report.financial.receivable.paid}, em aberto R$ ${report.financial.receivable.open}, vencidos ${report.financial.receivable.overdue}`,
    `Saldos iniciais: ${report.financial.initialBalances.accounts} conta(s), total R$ ${report.financial.initialBalances.total}`,
    '', 'BACKUPS DA MIGRACAO', ...(report.backups.length ? report.backups.map(backup => `${date(backup.createdAt)} ${backup.status}${backup.restoreVerified ? ' (restauracao testada)' : ''} sha256 ${backup.sha256?.slice(0, 16) ?? '-'}...${backup.error ? ` - ${backup.error}` : ''}`) : ['Nenhum backup gerado pela plataforma para esta migracao.']),
    '', '3. ARQUIVOS ANALISADOS', ...id.files.map(file => `${file.name} (${file.format}, ${file.size} bytes) sha256 ${file.sha256.slice(0, 16)}...`),
    '', '4. MAPEAMENTO', ...report.analysis.tables.flatMap(table => [`Tabela ${table.name} -> ${table.entity}${table.approved ? '' : ' (nao aprovada)'}; ${table.rows} linhas`, ...table.mapped.map(column => `   ${column.column} -> ${column.target} (${Math.round(column.confidence * 100)}%, ${column.source})`), ...(table.unmapped.length ? [`   Nao importadas: ${table.unmapped.join(', ')}`] : [])]),
    '', `5. CORRECOES REALIZADAS (${report.corrections.total})`, ...Object.entries(report.corrections.byRule).map(([rule, count]) => `${rule}: ${count}`),
    '', `6. PENDENCIAS (${report.pendencies.length})`, ...report.pendencies.slice(0, 40).map(item => `${item.table} linha ${item.row} [${STATUS_LABEL[item.status] ?? item.status}] ${item.messages.join(' | ')}`),
    '', `7. ERROS (${report.errors.length})`, ...report.errors.slice(0, 40).map(item => `${item.table} linha ${item.row}: ${item.messages.join(' | ')}`),
    '', '8. ALERTAS E LIMITACOES', ...report.alerts, ...report.analysis.warnings, ...report.analysis.limitations, ...report.analysis.unreadableFiles.map(item => `Arquivo ilegivel ${item.file}: ${item.message}`),
    '', '9. INTEGRIDADE FINAL', ...report.integrity.map(check => `[${check.ok ? 'OK' : 'FALHA'}] ${check.name}: ${check.detail}`),
  ];
  return lines;
}
