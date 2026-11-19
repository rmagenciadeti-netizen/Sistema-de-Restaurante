import { Prisma } from '@prisma/client';
import { stripAccents, tableKey, type MappingDocument, type TableMapping } from './mapper';
import { detectDateOrder, evaluateFields, type Correction, type EvalContext, type Issue, type NormalizedValues } from './fields';
import { phoneKey } from './normalize';
import type { SourceTable } from './readers';
import { ENTITIES, entryType, fieldOf, isFinancialEntry, outputKey, type EntityKey, type TargetField } from './targets';

export { evaluateFields };
export type { Correction, Issue, NormalizedValues };
export type RecordStatus = 'VALID' | 'DIVERGENT' | 'DUPLICATE' | 'REJECTED' | 'IGNORED' | 'IMPORTED' | 'FAILED' | 'REVERTED';
export type StagedRecord = {
  entity: EntityKey; tableName: string; rowIndex: number; sourceKey: string | null; status: RecordStatus; original: Record<string, string | null>;
  normalized: NormalizedValues; corrections: Correction[]; issues: Issue[]; approved: boolean; seq: number;
};
export type ExistingData = {
  categories: { name: string }[];
  products: { code: string | null; barcode: string | null; name: string; price: string }[];
  customers: { phone: string; document: string | null; name: string }[];
  suppliers: { name: string; document: string | null }[];
  finCategories?: { type: 'INCOME' | 'EXPENSE'; name: string }[];
  costCenters?: { name: string }[];
  bankAccounts?: { name: string }[];
  employees?: { cpf: string | null; fullName: string }[];
  saleNumbers?: string[];
  entries?: { type: 'INCOME' | 'EXPENSE'; documentNumber: string | null; description: string; dueAt: string | null; amount: string; installmentNumber: number | null; party: string }[];
};
export type StageStats = { refs: Record<string, { total: number; resolved: number; unresolved: number; derived: number }>; alerts: string[]; installments: { documents: number; incomplete: number } };

export const fold = (value: string) => stripAccents(value).toLowerCase().replace(/\s+/g, ' ').trim();
const blank = (value: string | null | undefined) => value === null || value === undefined || value.trim() === '';
const str = (values: NormalizedValues, key: string) => typeof values[key] === 'string' ? values[key] as string : null;

// ---- Identity (duplicate / conflict detection) ----
type Identity = { strong: string[]; weak?: string };
const display = (key: string) => key.slice(key.indexOf('/') + 1);
export function entryKey(entity: 'PAYABLE' | 'RECEIVABLE', values: { documentNumber?: string | null; description?: string | null; dueAt?: string | null; amount?: string | null; installment?: string | number | null; party?: string | null }): string {
  const party = fold(values.party ?? ''); const inst = values.installment ?? ''; const doc = values.documentNumber ? fold(values.documentNumber) : '';
  const amount = values.amount ? Number(values.amount).toFixed(2) : '';
  return `${entity}/${doc ? `doc:${doc}|party:${party}|inst:${inst}` : `sig:${fold(values.description ?? '')}|due:${values.dueAt ?? ''}|amt:${amount}|party:${party}|inst:${inst}`}`;
}
export function identityOf(entity: EntityKey, values: NormalizedValues): Identity {
  if (isFinancialEntry(entity)) return { strong: [entryKey(entity, { documentNumber: str(values, 'documentNumber'), description: str(values, 'description'), dueAt: str(values, 'dueAt'), amount: str(values, 'amount'), installment: str(values, 'installmentNumber'), party: str(values, 'supplierName') ?? str(values, 'customerName') })] };
  const identity = rawIdentity(entity, values);
  return { strong: identity.strong.map(key => `${entity}/${key}`), weak: identity.weak ? `${entity}/${identity.weak}` : undefined };
}
function rawIdentity(entity: EntityKey, values: NormalizedValues): Identity {
  const text = (key: string) => str(values, key);
  switch (entity) {
    case 'CATEGORY': case 'COST_CENTER': case 'BANK_ACCOUNT': return { strong: [`name:${fold(text('name') ?? '')}`] };
    case 'FIN_CATEGORY': return { strong: [`type:${text('type')}|name:${fold(text('name') ?? '')}`] };
    case 'PRODUCT': return { strong: [text('code') ? `code:${text('code')}` : '', text('barcode') ? `barcode:${text('barcode')}` : ''].filter(Boolean), weak: `name:${fold(text('name') ?? '')}` };
    case 'CUSTOMER': return { strong: [text('phone') ? `phone:${phoneKey(text('phone')!)}` : '', text('document') ? `document:${text('document')}` : ''].filter(Boolean) };
    case 'SUPPLIER': return { strong: [`name:${fold(text('name') ?? '')}`, text('document') ? `document:${text('document')}` : ''].filter(key => key !== 'name:') };
    case 'EMPLOYEE': return { strong: [text('cpf') ? `cpf:${text('cpf')}` : `name:${fold(text('fullName') ?? '')}`].filter(key => key !== 'name:') };
    case 'SALE': return { strong: text('saleNumber') ? [`number:${fold(text('saleNumber')!)}`] : [] };
    case 'SALE_ITEM': return { strong: text('saleNumber') && (text('productCode') || text('productName')) ? [`item:${fold(text('saleNumber')!)}|${fold(text('productCode') ?? text('productName')!)}|${text('quantity')}|${text('unitPrice')}`] : [] };
    default: return { strong: [] };
  }
}
const comparable = (entity: EntityKey, values: NormalizedValues) => ENTITIES[entity].fields.map(field => `${fold(String(values[outputKey(field)] ?? ''))}`).join('|');

// ---- Registries of structural names (categories, cost centres, bank accounts) ----
type RegistryEntity = 'CATEGORY' | 'FIN_CATEGORY' | 'COST_CENTER' | 'BANK_ACCOUNT';
const REGISTRY: RegistryEntity[] = ['CATEGORY', 'FIN_CATEGORY', 'COST_CENTER', 'BANK_ACCOUNT'];
const isRegistry = (entity: EntityKey | undefined): entity is RegistryEntity => entity !== undefined && (REGISTRY as string[]).includes(entity);
const regKey = (entity: RegistryEntity, name: string, type?: string | null) => entity === 'FIN_CATEGORY' ? `${type}:${fold(name)}` : fold(name);
type Derived = { entity: RegistryEntity; name: string; parentName: string | null; type: 'INCOME' | 'EXPENSE' | null };

type PartyIndex = { names: Map<string, number>; phones: Set<string>; docs: Set<string> };
const newIndex = (): PartyIndex => ({ names: new Map(), phones: new Set(), docs: new Set() });
function indexParty(index: PartyIndex, name: string | null, phone: string | null, document: string | null) {
  if (name) index.names.set(fold(name), (index.names.get(fold(name)) ?? 0) + 1);
  if (phone) index.phones.add(phoneKey(phone));
  if (document) index.docs.add(document);
}

type Lookup = { rows: Map<string, Record<string, string | null>>; entity: EntityKey; fieldColumns: Record<string, string>; cache: Map<string, { name: string | null; extras: NormalizedValues }> };
// Only a relation that ends in a table of the expected kind is used (a supplier column never resolves through a products table).
function buildLookup(tables: SourceTable[], mapping: MappingDocument, tableMapping: TableMapping, column: string, expected: EntityKey | undefined): Lookup | null {
  const relation = mapping.relationships.find(item => item.from.table === tableMapping.key && item.from.column === column && mapping.tables[item.to.table]?.entity === expected);
  const target = relation ? mapping.tables[relation.to.table] : null;
  const source = target ? tables.find(table => tableKey(table) === target.key) : null;
  if (!relation || !target || target.entity === 'IGNORE' || !source) return null;
  const fieldColumns: Record<string, string> = {};
  for (const [name, mapped] of Object.entries(target.columns)) if (mapped.target && fieldOf(target.entity, mapped.target)) fieldColumns[mapped.target] = name;
  if (!fieldColumns.name) return null;
  const rows = new Map<string, Record<string, string | null>>();
  for (const row of source.rows) { const key = row[relation.to.column]; if (key) rows.set(key.trim(), row); }
  return { rows, entity: target.entity, fieldColumns, cache: new Map() };
}
function resolveThroughLookup(lookup: Lookup, key: string) {
  const cached = lookup.cache.get(key); if (cached) return cached;
  const row = lookup.rows.get(key); let result: { name: string | null; extras: NormalizedValues } = { name: null, extras: {} };
  if (row) {
    const targetRaw: Record<string, string | null> = {}; for (const [field, column] of Object.entries(lookup.fieldColumns)) targetRaw[field] = row[column] ?? null;
    const { normalized } = evaluateFields(lookup.entity, targetRaw);
    result = { name: str(normalized, 'name'), extras: { document: str(normalized, 'document'), phone: str(normalized, 'phone') } };
  }
  lookup.cache.set(key, result); return result;
}

// ---- Staging ----
export function stageTables(tables: SourceTable[], mapping: MappingDocument, existing: ExistingData): StagedRecord[] {
  return stageTablesDetailed(tables, mapping, existing).records;
}

export function stageTablesDetailed(tables: SourceTable[], mapping: MappingDocument, existing: ExistingData, today = new Date()): { records: StagedRecord[]; stats: StageStats } {
  const out: StagedRecord[] = [];
  const stats: StageStats = { refs: {}, alerts: [], installments: { documents: 0, incomplete: 0 } };
  const seenStrong = new Map<string, { rowIndex: number; tableName: string; signature: string; price?: string }>(); const seenWeak = new Map<string, { rowIndex: number; tableName: string; signature: string; price?: string }[]>();
  const existingStrong = new Set<string>(); const existingNames = new Map<string, string>(); const existingProducts = new Map<string, string[]>();
  const known: Record<RegistryEntity, Map<string, string>> = { CATEGORY: new Map(), FIN_CATEGORY: new Map(), COST_CENTER: new Map(), BANK_ACCOUNT: new Map() };
  const derived: Record<RegistryEntity, Map<string, Derived>> = { CATEGORY: new Map(), FIN_CATEGORY: new Map(), COST_CENTER: new Map(), BANK_ACCOUNT: new Map() };
  const suppliers = newIndex(); const customers = newIndex();

  for (const product of existing.products) {
    if (product.code) { existingStrong.add(`PRODUCT/code:${product.code}`); existingNames.set(`PRODUCT/code:${product.code}`, product.name); }
    if (product.barcode) { existingStrong.add(`PRODUCT/barcode:${product.barcode}`); existingNames.set(`PRODUCT/barcode:${product.barcode}`, product.name); }
    const weak = `PRODUCT/name:${fold(product.name)}`;
    existingProducts.set(weak, [...(existingProducts.get(weak) ?? []), Number(product.price).toFixed(2)]);
  }
  for (const customer of existing.customers) {
    existingStrong.add(`CUSTOMER/phone:${phoneKey(customer.phone)}`); existingNames.set(`CUSTOMER/phone:${phoneKey(customer.phone)}`, customer.name);
    if (customer.document) { existingStrong.add(`CUSTOMER/document:${customer.document}`); existingNames.set(`CUSTOMER/document:${customer.document}`, customer.name); }
    indexParty(customers, customer.name, customer.phone, customer.document);
  }
  for (const supplier of existing.suppliers) { existingStrong.add(`SUPPLIER/name:${fold(supplier.name)}`); if (supplier.document) existingStrong.add(`SUPPLIER/document:${supplier.document}`); indexParty(suppliers, supplier.name, null, supplier.document); }
  for (const category of existing.categories) { existingStrong.add(`CATEGORY/name:${fold(category.name)}`); known.CATEGORY.set(regKey('CATEGORY', category.name), category.name); }
  for (const category of existing.finCategories ?? []) { existingStrong.add(`FIN_CATEGORY/type:${category.type}|name:${fold(category.name)}`); known.FIN_CATEGORY.set(regKey('FIN_CATEGORY', category.name, category.type), category.name); }
  for (const center of existing.costCenters ?? []) { existingStrong.add(`COST_CENTER/name:${fold(center.name)}`); known.COST_CENTER.set(regKey('COST_CENTER', center.name), center.name); }
  for (const account of existing.bankAccounts ?? []) { existingStrong.add(`BANK_ACCOUNT/name:${fold(account.name)}`); known.BANK_ACCOUNT.set(regKey('BANK_ACCOUNT', account.name), account.name); }
  for (const employee of existing.employees ?? []) existingStrong.add(employee.cpf ? `EMPLOYEE/cpf:${employee.cpf}` : `EMPLOYEE/name:${fold(employee.fullName)}`);
  for (const number of existing.saleNumbers ?? []) existingStrong.add(`SALE/number:${fold(number)}`);
  for (const entry of existing.entries ?? []) existingStrong.add(entryKey(entry.type === 'EXPENSE' ? 'PAYABLE' : 'RECEIVABLE', { documentNumber: entry.documentNumber, description: entry.description, dueAt: entry.dueAt, amount: entry.amount, installment: entry.installmentNumber, party: entry.party }));

  const bump = (key: string, field: 'total' | 'resolved' | 'unresolved' | 'derived') => { const bucket = stats.refs[key] ?? (stats.refs[key] = { total: 0, resolved: 0, unresolved: 0, derived: 0 }); bucket[field]++; };
  const parentLinks: { record: StagedRecord; entity: RegistryEntity; type: 'INCOME' | 'EXPENSE' | null }[] = [];
  const installmentGroups = new Map<string, { label: string; count: number; numbers: Set<number> }>();

  const ordered = Object.values(mapping.tables).filter(table => table.approved && table.entity !== 'IGNORE' && table.missingRequired.length === 0)
    .sort((a, b) => ENTITIES[a.entity as EntityKey].order - ENTITIES[b.entity as EntityKey].order);

  for (const tableMapping of ordered) {
    const table = tables.find(candidate => tableKey(candidate) === tableMapping.key); if (!table) continue;
    const entity = tableMapping.entity as EntityKey; const definition = ENTITIES[entity];
    const fieldColumns: Record<string, string> = {};
    for (const [column, mapped] of Object.entries(tableMapping.columns)) if (mapped.target && fieldOf(entity, mapped.target)) fieldColumns[mapped.target] = column;
    const ctx: EvalContext = { dateOrders: {}, today };
    for (const field of definition.fields.filter(item => item.kind === 'date' && fieldColumns[item.key])) {
      const { order, certain } = detectDateOrder(table.rows.map(row => row[fieldColumns[field.key]]).filter((value): value is string => value !== null));
      ctx.dateOrders![field.key] = order;
      if (!certain) stats.alerts.push(`Tabela "${table.name}", coluna "${fieldColumns[field.key]}": datas dd/mm e mm/dd indistinguíveis pelo conteúdo; foi assumido o padrão brasileiro dd/mm/aaaa.`);
    }
    const refFields = definition.fields.filter(field => field.kind === 'ref' && fieldColumns[field.key]);
    const lookups = new Map(refFields.map(field => [field.key, buildLookup(tables, mapping, tableMapping, fieldColumns[field.key], field.ref)]));

    table.rows.forEach((row, rowIndex) => {
      const raw: Record<string, string | null> = {};
      for (const [field, column] of Object.entries(fieldColumns)) raw[field] = row[column] ?? null;
      const extras: NormalizedValues = {}; const reconciled: Correction[] = []; const refIssues: Issue[] = [];
      for (const field of refFields) {
        const value = raw[field.key]; if (blank(value)) continue;
        const lookup = lookups.get(field.key);
        if (!lookup) {
          // A bare number without a related table is a code, not a name: it cannot be turned into a category/party.
          if (/^\d{1,9}$/.test(value!.trim())) { refIssues.push({ field: outputKey(field), severity: 'review', code: 'unresolved_reference', message: `${field.label}: "${value!.trim()}" parece um código, mas nenhuma tabela relacionada foi encontrada para traduzi-lo.`, suggestion: 'Envie também a tabela de origem desse cadastro, ou aprove para importar sem este vínculo.' }); raw[field.key] = null; bump(`${entity}.${field.key}`, 'total'); bump(`${entity}.${field.key}`, 'unresolved'); }
          continue;
        }
        const resolved = resolveThroughLookup(lookup, value!.trim());
        if (!resolved.name) {
          refIssues.push({ field: outputKey(field), severity: 'review', code: 'unresolved_reference', message: `${field.label} "${value!.trim()}" não foi encontrado na tabela relacionada.`, suggestion: 'Importe sem este vínculo ou corrija manualmente.' });
          raw[field.key] = null; bump(`${entity}.${field.key}`, 'total'); bump(`${entity}.${field.key}`, 'unresolved'); continue;
        }
        reconciled.push({ field: outputKey(field), column: fieldColumns[field.key], original: value, corrected: resolved.name, rule: 'reference_resolved', reason: `Código resolvido para "${resolved.name}" pela relação detectada entre as tabelas.` });
        raw[field.key] = resolved.name;
        if (field.ref === 'SUPPLIER') extras.supplierDocument = resolved.extras.document ?? null;
        if (field.ref === 'CUSTOMER') { extras.customerPhone = resolved.extras.phone ?? null; extras.customerDocument = resolved.extras.document ?? null; }
      }
      const { normalized, corrections, issues } = evaluateFields(entity, raw, fieldColumns, ctx);
      Object.assign(normalized, Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== null)));
      const toDerive: Derived[] = [];
      const type = isFinancialEntry(entity) ? entryType(entity) : null;
      for (const field of refFields) {
        const key = outputKey(field); const name = str(normalized, key);
        const refKey = `${entity}.${field.key}`;
        if (!name) continue;
        if (!(refIssues.some(issue => issue.field === key))) bump(refKey, 'total');
        if (isRegistry(field.ref)) {
          if (field.ref === entity) continue; // self parent: checked once every row is known
          const regType = field.ref === 'FIN_CATEGORY' ? (entity === 'FIN_CATEGORY' ? str(normalized, 'type') as 'INCOME' | 'EXPENSE' | null : type) : null;
          const registryKey = regKey(field.ref, name, regType);
          const canonical = known[field.ref].get(registryKey) ?? derived[field.ref].get(registryKey)?.name;
          if (canonical !== undefined) {
            if (canonical !== name) { reconciled.push({ field: key, column: fieldColumns[field.key], original: name, corrected: canonical, rule: 'name_match', reason: `"${name}" reconciliado com "${canonical}" já existente (mesmo nome sem diferença de caixa/acento).` }); normalized[key] = canonical; }
            bump(refKey, 'resolved');
          } else {
            const isSub = field.key === 'subcategoryRef'; const parent = isSub ? str(normalized, key.replace('subcategory', 'category')) : null;
            toDerive.push({ entity: field.ref, name, parentName: parent, type: regType });
          }
        } else {
          const index = field.ref === 'SUPPLIER' ? suppliers : customers;
          const document = field.ref === 'SUPPLIER' ? str(normalized, 'supplierDocument') : str(normalized, 'customerDocument');
          const phone = field.ref === 'CUSTOMER' ? str(normalized, 'customerPhone') : null;
          const count = index.names.get(fold(name)) ?? 0;
          const found = (document !== null && index.docs.has(document)) || (phone !== null && index.phones.has(phoneKey(phone))) || count === 1;
          if (found) bump(refKey, 'resolved');
          else {
            bump(refKey, 'unresolved');
            refIssues.push({ field: key, severity: 'review', code: count > 1 ? 'ambiguous_reference' : 'unresolved_reference', message: count > 1 ? `${field.label} "${name}" corresponde a mais de um cadastro; não é possível escolher automaticamente.` : `${field.label} "${name}" não existe no RM Restaurant nem na migração; o lançamento ficaria sem vínculo (nome preservado).`, suggestion: 'Inclua o cadastro na migração, ou aprove para importar sem o vínculo.' });
          }
        }
      }
      const record: StagedRecord = {
        entity, tableName: table.name, rowIndex, sourceKey: tableMapping.sourceKey ? row[tableMapping.sourceKey] ?? null : null, status: 'VALID', original: row,
        normalized, corrections: [...corrections, ...reconciled], issues: [...issues, ...refIssues], approved: true, seq: 0,
      };
      classify(record, seenStrong, seenWeak, existingStrong, existingProducts, existingNames);
      const usable = record.status === 'VALID' || record.status === 'DIVERGENT';
      if (usable) for (const item of toDerive) {
        const registryKey = regKey(item.entity, item.name, item.type);
        if (!derived[item.entity].has(registryKey) && !known[item.entity].has(registryKey)) { derived[item.entity].set(registryKey, item); bump(`${entity}.${item.entity === 'CATEGORY' && item.parentName === null ? 'categoryRef' : item.entity === 'CATEGORY' ? 'subcategoryRef' : item.entity === 'FIN_CATEGORY' ? (item.parentName === null ? 'categoryRef' : 'subcategoryRef') : item.entity === 'COST_CENTER' ? 'costCenterRef' : 'bankAccountRef'}`, 'derived'); }
        if (item.parentName) { const parentKey = regKey(item.entity, item.parentName, item.type); if (!derived[item.entity].has(parentKey) && !known[item.entity].has(parentKey)) derived[item.entity].set(parentKey, { entity: item.entity, name: item.parentName, parentName: null, type: item.type }); }
      }
      if (record.status !== 'REJECTED' && record.status !== 'IGNORED') {
        if (isRegistry(entity)) {
          const name = str(normalized, 'name');
          const registryKey = name ? regKey(entity, name, entity === 'FIN_CATEGORY' ? str(normalized, 'type') : null) : null;
          // The spelling already registered in the restaurant (or by an earlier row) always wins.
          if (name && registryKey && !known[entity].has(registryKey)) known[entity].set(registryKey, name);
          if ((entity === 'CATEGORY' || entity === 'FIN_CATEGORY') && str(normalized, 'parentName')) parentLinks.push({ record, entity, type: entity === 'FIN_CATEGORY' ? str(normalized, 'type') as 'INCOME' | 'EXPENSE' : null });
        }
        if (usable && entity === 'SUPPLIER') indexParty(suppliers, str(normalized, 'name'), null, str(normalized, 'document'));
        if (usable && entity === 'CUSTOMER') indexParty(customers, str(normalized, 'name'), str(normalized, 'phone') ?? str(normalized, 'whatsapp'), str(normalized, 'document'));
      }
      if (usable && isFinancialEntry(entity) && str(normalized, 'documentNumber') && str(normalized, 'installmentCount')) {
        const party = str(normalized, 'supplierName') ?? str(normalized, 'customerName') ?? '';
        const key = `${entity}|${fold(party)}|${fold(str(normalized, 'documentNumber')!)}`;
        const group = installmentGroups.get(key) ?? { label: `${entity === 'PAYABLE' ? 'Pagar' : 'Receber'} · documento ${str(normalized, 'documentNumber')}${party ? ` (${party})` : ''}`, count: Number(str(normalized, 'installmentCount')), numbers: new Set<number>() };
        if (str(normalized, 'installmentNumber')) group.numbers.add(Number(str(normalized, 'installmentNumber')));
        installmentGroups.set(key, group);
      }
      out.push(record);
    });
  }

  // Parents referenced by category trees must exist: they are created from the same names when absent from the source.
  for (const link of parentLinks) {
    const parent = str(link.record.normalized, 'parentName')!;
    const registryKey = regKey(link.entity, parent, link.type);
    if (!known[link.entity].has(registryKey) && !derived[link.entity].has(registryKey)) { derived[link.entity].set(registryKey, { entity: link.entity, name: parent, parentName: null, type: link.type }); bump(`${link.entity}.parentRef`, 'derived'); }
  }
  let derivedIndex = 0;
  for (const entityKey of REGISTRY) for (const item of derived[entityKey].values()) {
    out.push({
      entity: entityKey, tableName: '(derivados dos registros importados)', rowIndex: derivedIndex++, sourceKey: null, status: 'VALID', original: { name: item.name },
      normalized: { name: item.name, ...(item.parentName ? { parentName: item.parentName } : {}), ...(item.type ? { type: item.type } : {}) }, corrections: [],
      issues: [{ field: 'name', severity: 'info', code: 'derived', message: 'Criado a partir dos nomes usados por outros registros da origem.' }], approved: true, seq: 0,
    });
  }
  assignDepth(out);
  for (const group of installmentGroups.values()) {
    stats.installments.documents++;
    const missing = Array.from({ length: Math.min(group.count, 999) }, (_, index) => index + 1).filter(number => !group.numbers.has(number));
    if (missing.length > 0) { stats.installments.incomplete++; if (stats.alerts.length < 40) stats.alerts.push(`${group.label}: faltam as parcelas ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''} de ${group.count} (não serão inventadas).`); }
  }
  return { records: out, stats };
}

// Parents are imported before children: depth of each category in its tree.
function assignDepth(records: StagedRecord[]) {
  const parents = new Map<string, string | null>();
  for (const record of records) if (record.entity === 'CATEGORY' || record.entity === 'FIN_CATEGORY') parents.set(`${record.entity}|${record.normalized.type ?? ''}|${fold(String(record.normalized.name ?? ''))}`, str(record.normalized, 'parentName'));
  for (const record of records) {
    if (record.entity !== 'CATEGORY' && record.entity !== 'FIN_CATEGORY') continue;
    let depth = 0; let parent = str(record.normalized, 'parentName');
    while (parent && depth < 12) { depth++; parent = parents.get(`${record.entity}|${record.normalized.type ?? ''}|${fold(parent)}`) ?? null; }
    record.seq = depth;
  }
}

function classify(record: StagedRecord, seenStrong: Map<string, { rowIndex: number; tableName: string; signature: string; price?: string }>, seenWeak: Map<string, { rowIndex: number; tableName: string; signature: string; price?: string }[]>, existingStrong: Set<string>, existingProducts: Map<string, string[]>, existingNames: Map<string, string>) {
  const hasError = record.issues.some(issue => issue.severity === 'error');
  const hasReview = record.issues.some(issue => issue.severity === 'review');
  if (hasError) { record.status = 'REJECTED'; record.approved = false; return; }
  const identity = identityOf(record.entity, record.normalized);
  const signature = comparable(record.entity, record.normalized);
  const price = typeof record.normalized.price === 'string' ? Number(record.normalized.price).toFixed(2) : undefined;
  const mark = (status: RecordStatus, issue?: Issue) => { record.status = status; if (issue) record.issues.push(issue); record.approved = status === 'VALID'; };
  const existingHit = identity.strong.find(key => existingStrong.has(key));
  const existingName = existingHit ? existingNames.get(existingHit) : undefined;
  if (existingHit && existingName !== undefined && fold(existingName) !== fold(String(record.normalized.name ?? ''))) {
    return mark('DIVERGENT', { field: display(existingHit).split(':')[0], severity: 'review', code: 'conflict_existing', message: `A chave (${display(existingHit).replace(':', ' = ')}) já pertence a "${existingName}" no RM Restaurant, mas a origem traz "${String(record.normalized.name ?? '')}".`, suggestion: 'Não é possível escolher automaticamente; ignore o registro ou altere a chave manualmente.' });
  }
  if (existingHit) return mark('DUPLICATE', { field: display(existingHit).split(':')[0], severity: 'info', code: 'exists', message: isFinancialEntry(record.entity) ? 'Lançamento equivalente já existe no RM Restaurante; não será importado novamente.' : `Já existe no RM Restaurant um registro com ${display(existingHit).replace(':', ' = ')}; não será importado novamente.` });
  for (const key of identity.strong) {
    const first = seenStrong.get(key);
    if (!first) continue;
    if (first.signature === signature) return mark('DUPLICATE', { field: display(key).split(':')[0], severity: 'info', code: 'duplicate_in_source', message: `Repetido na origem (idêntico à linha ${first.rowIndex + 2} de ${first.tableName}).` });
    return mark('DIVERGENT', { field: display(key).split(':')[0], severity: 'review', code: 'conflict', message: `Conflito: mesma chave (${display(key).replace(':', ' = ').slice(0, 120)}) da linha ${first.rowIndex + 2} de ${first.tableName}, mas com dados diferentes.`, suggestion: 'Não é possível escolher automaticamente; ignore um dos registros ou altere a chave.' });
  }
  if (record.entity === 'PRODUCT' && identity.weak) {
    const priorExisting = existingProducts.get(identity.weak);
    const priorStaged = seenWeak.get(identity.weak) ?? [];
    const prices = [...(priorExisting ?? []), ...priorStaged.map(item => item.price)].filter(Boolean);
    if (prices.length > 0) {
      if (prices.includes(price)) return mark('DUPLICATE', { field: 'name', severity: 'info', code: 'same_name_price', message: 'Já existe produto com o mesmo nome e preço.' });
      record.issues.push({ field: 'name', severity: 'review', code: 'possible_duplicate', message: 'Já existe produto com o mesmo nome e preço diferente.', suggestion: 'Confirme se são itens distintos (ex.: tamanhos) antes de importar.' });
      record.status = 'DIVERGENT'; record.approved = false;
      for (const key of identity.strong) seenStrong.set(key, { rowIndex: record.rowIndex, tableName: record.tableName, signature, price });
      return;
    }
  }
  for (const key of identity.strong) seenStrong.set(key, { rowIndex: record.rowIndex, tableName: record.tableName, signature, price });
  if (identity.weak) seenWeak.set(identity.weak, [...(seenWeak.get(identity.weak) ?? []), { rowIndex: record.rowIndex, tableName: record.tableName, signature, price }]);
  if (hasReview) { record.status = 'DIVERGENT'; record.approved = false; }
}

export function summarizeStaged(records: Pick<StagedRecord, 'entity' | 'status' | 'corrections' | 'issues'>[]) {
  const byEntity: Record<string, Record<string, number>> = {};
  let corrections = 0; const issueCodes: Record<string, number> = {};
  for (const record of records) {
    const bucket = byEntity[record.entity] ?? (byEntity[record.entity] = {});
    bucket[record.status] = (bucket[record.status] ?? 0) + 1; bucket.total = (bucket.total ?? 0) + 1;
    corrections += record.corrections.length;
    for (const issue of record.issues) issueCodes[issue.code] = (issueCodes[issue.code] ?? 0) + 1;
  }
  return { byEntity, corrections, issueCodes, total: records.length };
}

// ---- Financial totals (preview, report and post-migration checks) ----
export type FinancialBucket = { count: number; amount: string; interest: string; discount: string; paid: string; open: string; overdue: number; byStatus: { open: number; partial: number; paid: number; cancelled: number } };
export type FinancialTotals = { payable: FinancialBucket; receivable: FinancialBucket; initialBalances: { accounts: number; total: string } };
const emptyBucket = () => ({ count: 0, amount: new Prisma.Decimal(0), interest: new Prisma.Decimal(0), discount: new Prisma.Decimal(0), paid: new Prisma.Decimal(0), open: new Prisma.Decimal(0), overdue: 0, byStatus: { open: 0, partial: 0, paid: 0, cancelled: 0 } });
export function financialTotals(records: { entity: string; normalized: unknown }[], today = new Date()): FinancialTotals {
  const buckets = { PAYABLE: emptyBucket(), RECEIVABLE: emptyBucket() }; let accounts = 0; let balance = new Prisma.Decimal(0);
  const todayIso = today.toISOString().slice(0, 10);
  for (const record of records) {
    const values = (record.normalized ?? {}) as NormalizedValues;
    if (record.entity === 'BANK_ACCOUNT') { accounts++; if (str(values, 'initialBalance')) balance = balance.add(str(values, 'initialBalance')!); continue; }
    if (record.entity !== 'PAYABLE' && record.entity !== 'RECEIVABLE') continue;
    const bucket = buckets[record.entity]; const amount = new Prisma.Decimal(str(values, 'amount') ?? 0); const paid = new Prisma.Decimal(str(values, 'paidAmount') ?? 0);
    const interest = new Prisma.Decimal(str(values, 'interestAmount') ?? 0); const discount = new Prisma.Decimal(str(values, 'discountAmount') ?? 0);
    bucket.count++; bucket.amount = bucket.amount.add(amount); bucket.interest = bucket.interest.add(interest); bucket.discount = bucket.discount.add(discount); bucket.paid = bucket.paid.add(paid);
    const status = str(values, 'status');
    if (status === 'PAID') bucket.byStatus.paid++;
    else if (status === 'CANCELLED') bucket.byStatus.cancelled++;
    else { if (paid.gt(0)) bucket.byStatus.partial++; else bucket.byStatus.open++; bucket.open = bucket.open.add(amount.add(interest).sub(discount).sub(paid)); const due = str(values, 'dueAt'); if (due && due < todayIso) bucket.overdue++; }
  }
  const plain = (bucket: ReturnType<typeof emptyBucket>): FinancialBucket => ({ ...bucket, amount: bucket.amount.toFixed(2), interest: bucket.interest.toFixed(2), discount: bucket.discount.toFixed(2), paid: bucket.paid.toFixed(2), open: bucket.open.toFixed(2) });
  return { payable: plain(buckets.PAYABLE), receivable: plain(buckets.RECEIVABLE), initialBalances: { accounts, total: balance.toFixed(2) } };
}
export type { TargetField };
