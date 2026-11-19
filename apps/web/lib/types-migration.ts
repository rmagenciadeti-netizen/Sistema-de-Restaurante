export type MigrationStatus = 'DRAFT' | 'ANALYZED' | 'PREVIEWED' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'CANCELLED' | 'ROLLING_BACK' | 'ROLLED_BACK';
export type MigrationOutcome = 'VALIDATED' | 'WITH_CAVEATS' | 'PARTIAL' | 'INTERRUPTED' | 'FAILED_VALIDATION';
export type EntityKey = 'CATEGORY' | 'PRODUCT' | 'CUSTOMER' | 'SUPPLIER' | 'FIN_CATEGORY' | 'COST_CENTER' | 'BANK_ACCOUNT' | 'PAYABLE' | 'RECEIVABLE' | 'EMPLOYEE' | 'SALE' | 'SALE_ITEM';
export type GroupKey = 'products' | 'customers' | 'suppliers' | 'payables' | 'receivables' | 'finance' | 'employees' | 'sales';

export const statusLabels: Record<string, string> = { DRAFT: 'Rascunho', ANALYZED: 'Analisada', PREVIEWED: 'Pré-visualizada', APPROVED: 'Aprovada', RUNNING: 'Em execução', COMPLETED: 'Concluída', INTERRUPTED: 'Interrompida', CANCELLED: 'Cancelada', ROLLING_BACK: 'Em reversão', ROLLED_BACK: 'Revertida' };
export const outcomeLabels: Record<string, string> = { VALIDATED: 'Concluída e validada', WITH_CAVEATS: 'Concluída com ressalvas', PARTIAL: 'Parcialmente concluída', INTERRUPTED: 'Interrompida', FAILED_VALIDATION: 'Reprovada na validação' };
export const outcomeTone = (outcome?: string | null): 'green' | 'amber' | 'red' | 'neutral' => outcome === 'VALIDATED' ? 'green' : outcome === 'WITH_CAVEATS' || outcome === 'PARTIAL' ? 'amber' : outcome ? 'red' : 'neutral';
export const recordStatusLabels: Record<string, string> = { VALID: 'Válido', DIVERGENT: 'Divergente', DUPLICATE: 'Duplicado', REJECTED: 'Rejeitado', IGNORED: 'Ignorado', IMPORTED: 'Importado', FAILED: 'Falhou', REVERTED: 'Revertido' };
export const recordTone = (status: string): 'green' | 'amber' | 'red' | 'neutral' | 'blue' => ({ VALID: 'green', IMPORTED: 'green', DIVERGENT: 'amber', DUPLICATE: 'neutral', IGNORED: 'neutral', REJECTED: 'red', FAILED: 'red', REVERTED: 'blue' } as const)[status as 'VALID'] ?? 'neutral';
export const entityLabels: Record<string, string> = { CATEGORY: 'Categorias de produtos', PRODUCT: 'Produtos', CUSTOMER: 'Clientes', SUPPLIER: 'Fornecedores', FIN_CATEGORY: 'Categorias financeiras', COST_CENTER: 'Centros de custo', BANK_ACCOUNT: 'Contas bancárias e saldos', PAYABLE: 'Contas a pagar', RECEIVABLE: 'Contas a receber', EMPLOYEE: 'Funcionários (cadastro)', SALE: 'Vendas históricas', SALE_ITEM: 'Itens das vendas', IGNORE: 'Ignorar tabela' };
export const entityOrder: (EntityKey | 'IGNORE')[] = ['PRODUCT', 'CATEGORY', 'CUSTOMER', 'SUPPLIER', 'PAYABLE', 'RECEIVABLE', 'FIN_CATEGORY', 'COST_CENTER', 'BANK_ACCOUNT', 'EMPLOYEE', 'SALE', 'SALE_ITEM', 'IGNORE'];
export type Group = { key: GroupKey; label: string; icon: string; entities: EntityKey[] };
export const refLabels: Record<string, string> = { 'PRODUCT.supplierRef': 'Produto → fornecedor', 'PRODUCT.categoryRef': 'Produto → categoria', 'PRODUCT.subcategoryRef': 'Produto → subcategoria', 'PAYABLE.supplierRef': 'Conta a pagar → fornecedor', 'RECEIVABLE.customerRef': 'Conta a receber → cliente', 'PAYABLE.categoryRef': 'Conta a pagar → categoria', 'RECEIVABLE.categoryRef': 'Conta a receber → categoria', 'PAYABLE.subcategoryRef': 'Conta a pagar → subcategoria', 'RECEIVABLE.subcategoryRef': 'Conta a receber → subcategoria', 'PAYABLE.costCenterRef': 'Conta a pagar → centro de custo', 'RECEIVABLE.costCenterRef': 'Conta a receber → centro de custo', 'PAYABLE.bankAccountRef': 'Conta a pagar → conta bancária', 'RECEIVABLE.bankAccountRef': 'Conta a receber → conta bancária', 'CATEGORY.parentRef': 'Categoria → superior', 'FIN_CATEGORY.parentRef': 'Categoria financeira → superior' };
export const sourceLabels: Record<string, string> = { rule: 'Regra', ai: 'IA', template: 'Modelo salvo', operator: 'Operador' };

export type Capabilities = {
  engineVersion: string; aiAvailable: boolean; backupRequired: boolean; backup?: { required: boolean; maxAgeMinutes: number; storageConfigured: boolean; encrypted: boolean; restoreTarget: 'separate-database' | 'scratch-schema' }; groups: Group[]; unsupportedFormats: string[]; unsupportedModules: string[];
  formats: { key: string; label: string; note: string }[];
  entities: { key: EntityKey; label: string; group: GroupKey; order: number; fields: { key: string; label: string; required: boolean; kind: string }[] }[];
  limits: { maxFileBytes: number; maxFiles: number; maxRowsPerTable: number; batchSize: number };
};
export type MappingColumn = { target: string | null; confidence: number; level: string; reason: string; source: string; needsReview: boolean };
export type MappingTable = { key: string; name: string; file: string; entity: EntityKey | 'IGNORE'; entityConfidence: number; entityReason: string; columns: Record<string, MappingColumn>; sourceKey: string | null; approved: boolean; missingRequired: string[] };
export type Mapping = { tables: Record<string, MappingTable>; relationships: { from: { table: string; column: string }; to: { table: string; column: string }; matchRatio: number }[] };
export type AnalysisTable = { key: string; name: string; file: string; rowCount: number; truncated: boolean; columns: { name: string; type: string | null; dominant: string; samples: string[]; nullRatio: number; uniqueRatio: number }[] };
export type Analysis = { files: { name: string; format: string; encoding: string; warnings: string[]; limitations: string[] }[]; errors: { file: string; message: string }[]; warnings: string[]; limitations: string[]; tables: AnalysisTable[]; ai?: { applied: number; calls: number; warnings: string[] } };
export type Summary = {
  tablesFound?: number; tablesMapped?: number; fieldsRecognised?: number; fieldsWithoutMatch?: number; importable?: number; ignored?: number; pendingReview?: number; corrections?: number; total?: number;
  byEntity?: Record<string, Record<string, number>>; financial?: Financial; refs?: Record<string, { total: number; resolved: number; unresolved: number; derived: number }>; installments?: { documents: number; incomplete: number }; rowsByTable?: { table: string; rows: number; entity: string }[]; alerts?: string[]; estimate?: { batches: number; seconds: number };
};
export type FinancialBucket = { count: number; amount: string; interest: string; discount: string; paid: string; open: string; overdue: number; byStatus: { open: number; partial: number; paid: number; cancelled: number } };
export type Financial = { payable: FinancialBucket; receivable: FinancialBucket; initialBalances: { accounts: number; total: string } };
export type SessionListItem = { id: string; label: string; sourceSystem: string | null; sourceUnknown: boolean; status: MigrationStatus; outcome: MigrationOutcome | null; createdAt: string; startedAt: string | null; finishedAt: string | null; summary: Summary | null };
export type SessionDetail = SessionListItem & { tenantId: string; unitId?: string | null; backupReference?: string | null; updatedAt: string; files: { id: string; name: string; size: number; sha256: string; format: string; purgedAt: string | null }[]; analysis: Analysis | null; mapping: Mapping | null; validation: { checks: { name: string; ok: boolean; detail: string }[]; alerts: string[]; counts: Record<string, number> } | null; approvedAt: string | null };
export type Correction = { field: string; column?: string; original: string | null; corrected: string | boolean | null; rule: string; reason: string };
export type Issue = { field: string; severity: 'error' | 'review' | 'info'; code: string; message: string; suggestion?: string };
export type StagedRecord = { id: string; entity: EntityKey; tableName: string; rowIndex: number; status: string; approved: boolean; original: Record<string, string | null>; normalized: Record<string, string | boolean | null>; corrections: Correction[]; issues: Issue[]; error: string | null; targetId: string | null };
export type MigrationEvent = { id: string; type: string; message: string; createdAt: string; actorUserId?: string | null; actorName?: string | null };
export type ReportBackup = { id: string; status: string; stage: string | null; createdAt: string; verifiedAt: string | null; sha256: string | null; fileSize: number | null; encrypted: boolean; error: string | null; restoreVerified: boolean; database: string | null };
export type Report = {
  overall: { statusLabel: string; outcome: string | null; outcomeLabel: string };
  backups: ReportBackup[];
  identification: { restaurant: string; operator: string | null; executedBy?: string | null; approvedBy: string | null; sourceSystem: string; engineVersion?: string; backupReference?: string | null };
  groups: { key: GroupKey; label: string; read: number; imported: number; duplicates: number; rejected: number; failed: number; ignored: number; pending: number }[];
  financial: Financial;
  comparison: { entity: string; label: string; read: number; imported: number; duplicates: number; rejected: number; failed: number; ignored: number; pending: number; reverted: number }[];
  result: { totals: { read: number; imported: number; duplicates: number; rejected: number; failed: number; ignored: number; pending: number }; durationSeconds: number | null };
  corrections: { total: number; byRule: Record<string, number> };
  pendencies: { table: string; row: number; status: string; messages: string[] }[]; errors: { table: string; row: number; messages: string[] }[];
  alerts: string[]; integrity: { name: string; ok: boolean; detail: string }[];
  analysis: { warnings: string[]; limitations: string[]; unreadableFiles: { file: string; message: string }[] };
};
