import { createHash } from 'node:crypto';
import type { SourceTable } from './readers';
import { ENTITIES, ENTITY_KEYS, missingRequiredFields, type EntityKey, type FieldKind, type TargetField } from './targets';
import { normalizeDocument, normalizeState, parseBoolean, parseDateValue, parseEntryStatus, parseFinType, parseInstallment, parseMoney, validGtin } from './normalize';

export type Confidence = 'direct' | 'probable' | 'low';
export type ColumnMapping = { target: string | null; confidence: number; level: Confidence | 'none'; reason: string; source: 'rule' | 'ai' | 'template' | 'operator'; needsReview: boolean; alternatives?: { target: string; confidence: number }[] };
export type TableMapping = {
  key: string; name: string; file: string; entity: EntityKey | 'IGNORE'; entityConfidence: number; entityReason: string;
  columns: Record<string, ColumnMapping>; sourceKey: string | null; approved: boolean; missingRequired: string[];
};
export type Relationship = { from: { table: string; column: string }; to: { table: string; column: string }; matchRatio: number };
export type MappingDocument = { tables: Record<string, TableMapping>; relationships: Relationship[] };
export type ColumnProfile = { name: string; samples: string[]; nullRatio: number; uniqueRatio: number; avgLength: number; dominant: FieldKind | 'text' | 'empty'; ratios: Partial<Record<FieldKind, number>> };

export const tableKey = (table: Pick<SourceTable, 'file' | 'name'>) => `${table.file}::${table.name}`;

// ---- Name matching ----
export const stripAccents = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ABBREVIATIONS: Record<string, string> = {
  vl: 'valor', vlr: 'valor', qtd: 'quantidade', qtde: 'quantidade', qty: 'quantidade', cod: 'codigo', cd: 'codigo', desc: 'descricao', descr: 'descricao',
  prod: 'produto', cli: 'cliente', cat: 'categoria', categ: 'categoria', fone: 'telefone', tel: 'telefone', cel: 'celular', end: 'endereco', obs: 'observacao',
  forn: 'fornecedor', un: 'unidade', und: 'unidade', unid: 'unidade', prc: 'preco', pr: 'preco', nm: 'nome', grp: 'grupo', min: 'minimo', max: 'maximo', est: 'estoque', doc: 'documento', gr: 'grupo',
};
export function tokens(value: string): string[] {
  const spaced = stripAccents(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return spaced === '' ? [] : spaced.split(' ').map(token => ABBREVIATIONS[token] ?? token).filter(token => !['tb', 'tbl', 'cad', 'de', 'do', 'da', 'dos', 'das'].includes(token));
}
const tokenSimilarity = (a: string, b: string) => a === b ? 1 : Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)) ? 0.75 : 0;
function phraseScore(column: string[], phrase: string[]): number {
  if (column.length === 0 || phrase.length === 0) return 0;
  const hit = (from: string[], to: string[]) => from.reduce((sum, token) => sum + Math.max(0, ...to.map(other => tokenSimilarity(token, other))), 0);
  return (hit(phrase, column) / Math.max(phrase.length, column.length) + hit(column, phrase) / Math.max(phrase.length, column.length)) / 2;
}
export function nameScore(columnName: string, field: TargetField): { score: number; alias: string } {
  const column = tokens(columnName); let best = { score: 0, alias: '' };
  for (const alias of field.aliases) {
    const score = phraseScore(column, tokens(alias));
    if (score > best.score) best = { score, alias };
  }
  return best;
}

// ---- Content profiling ----
const SENSITIVE = /(senha|password|passwd|token|cartao|card_?num|cvv|secret|hash|pin\b|api_?key)/i;
const SYSTEM = /^(id|uuid|guid|created_?at|updated_?at|deleted_?at|data_?cad(astro)?|dt_?cad|data_?alt(eracao)?|criado_?em|atualizado_?em|row_?version|version)$/i;
export const isSensitiveColumn = (name: string) => SENSITIVE.test(stripAccents(name));
export const isSystemColumn = (name: string) => SYSTEM.test(stripAccents(name).trim());

function sampleValues(table: SourceTable, column: string, limit = 500): string[] {
  const out: string[] = []; const step = Math.max(1, Math.floor(table.rows.length / limit));
  for (let i = 0; i < table.rows.length && out.length < limit; i += step) { const value = table.rows[i][column]; if (value !== null && value !== undefined && value.trim() !== '') out.push(value); }
  return out;
}
const ratio = (values: string[], predicate: (value: string) => boolean) => values.length === 0 ? 0 : values.filter(predicate).length / values.length;
const UNIT_WORDS = new Set(['un', 'und', 'unid', 'unidade', 'kg', 'g', 'gr', 'l', 'lt', 'ml', 'cx', 'caixa', 'pct', 'pacote', 'porcao', 'porção', 'porc', 'pc', 'peça', 'peca']);

export function profileColumn(table: SourceTable, column: string): ColumnProfile {
  const values = sampleValues(table, column);
  const total = Math.max(table.rows.length, 1);
  const filled = table.rows.reduce((count, row) => count + (row[column] === null || row[column] === undefined || row[column]!.trim() === '' ? 0 : 1), 0);
  const distinct = new Set(values).size;
  const ratios: Partial<Record<FieldKind, number>> = {
    money: ratio(values, value => { const parsed = parseMoney(value); return parsed.ok || Boolean(!parsed.ok && parsed.ambiguous); }) * (ratio(values, value => /[.,]\d{1,2}$|^\d+$/.test(value.trim().replace(/^R\$\s*/i, ''))) > 0.5 ? 1 : 0.6),
    quantity: ratio(values, value => /^-?\d+(?:[.,]\d{1,3})?$/.test(value.trim())),
    int: ratio(values, value => /^\d{1,6}$/.test(value.trim())),
    document: ratio(values, value => { const digits = value.replace(/\D/g, ''); return (digits.length === 11 || digits.length === 14 || digits.length >= 9) && normalizeDocument(value).ok; }),
    phone: ratio(values, value => { const digits = value.replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 13 && /^[\d\s()+-]+$/.test(value.trim()); }),
    email: ratio(values, value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())),
    barcode: ratio(values, value => /^\d{8,14}$/.test(value.trim()) && validGtin(value.trim())),
    boolean: ratio(values, value => parseBoolean(value) !== null),
    unit: ratio(values, value => UNIT_WORDS.has(value.trim().toLowerCase().replace(/\.$/, ''))),
    ncm: ratio(values, value => /^\d{8}$/.test(value.trim().replace(/\./g, ''))),
    zip: ratio(values, value => /^\d{5}-?\d{3}$|^\d{7}$/.test(value.trim())),
    state: ratio(values, value => normalizeState(value).ok),
    finType: ratio(values, value => parseFinType(value) !== null),
    entryStatus: ratio(values, value => parseEntryStatus(value) !== null),
    installment: ratio(values, value => parseInstallment(value) !== null),
  };
  const dateRatio = ratio(values, value => parseDateValue(value) !== null);
  ratios.date = dateRatio;
  const order: FieldKind[] = ['email', 'barcode', 'document', 'boolean', 'unit', 'ncm', 'phone', 'money', 'quantity', 'int'];
  let dominant: ColumnProfile['dominant'] = values.length === 0 ? 'empty' : 'text';
  for (const kind of order) if ((ratios[kind] ?? 0) >= 0.85 && dateRatio < 0.5) { dominant = kind; break; }
  // A column of small integers with few distinct values reads as a flag/code rather than a quantity.
  if (dominant === 'text' && dateRatio >= 0.85) dominant = 'text';
  return { name: column, samples: values.slice(0, 5).map(value => value.slice(0, 60)), nullRatio: 1 - filled / total, uniqueRatio: values.length === 0 ? 0 : distinct / values.length, avgLength: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value.length, 0) / values.length, dominant, ratios };
}

function contentScore(profile: ColumnProfile, kind: FieldKind): number {
  const r = profile.ratios;
  switch (kind) {
    case 'money': return (r.money ?? 0) >= 0.85 && (r.int ?? 0) < 0.99 ? 1 : (r.money ?? 0) >= 0.85 ? 0.7 : (r.money ?? 0) * 0.5;
    case 'quantity': return (r.quantity ?? 0) >= 0.85 ? 0.9 : (r.quantity ?? 0) * 0.5;
    case 'int': return (r.int ?? 0) >= 0.85 ? 0.9 : 0.1;
    case 'document': return (r.document ?? 0) >= 0.7 ? 1 : (r.document ?? 0);
    case 'phone': return (r.date ?? 0) >= 0.5 ? 0 : (r.phone ?? 0) >= 0.8 && (r.document ?? 0) < 0.6 ? 0.9 : (r.phone ?? 0) * 0.4;
    case 'email': return (r.email ?? 0) >= 0.7 ? 1 : 0;
    case 'barcode': return (r.barcode ?? 0) >= 0.7 ? 1 : (r.barcode ?? 0) * 0.5;
    case 'boolean': return (r.boolean ?? 0) >= 0.9 ? 0.9 : 0.1;
    case 'unit': return (r.unit ?? 0) >= 0.8 ? 1 : 0.1;
    case 'ncm': return (r.ncm ?? 0) >= 0.8 ? 1 : 0;
    case 'code': return profile.uniqueRatio >= 0.9 && profile.avgLength <= 20 ? 0.8 : profile.avgLength <= 20 ? 0.5 : 0.2;
    case 'ref': return (r.date ?? 0) >= 0.5 ? 0.1 : profile.dominant === 'text' || profile.dominant === 'int' ? 0.7 : 0.3;
    case 'balance': case 'percent': return (r.money ?? 0) >= 0.85 ? 1 : (r.money ?? 0) * 0.5;
    case 'date': return (r.date ?? 0) >= 0.85 ? 1 : (r.date ?? 0) * 0.5;
    case 'zip': return (r.zip ?? 0) >= 0.8 ? 1 : 0.1;
    case 'state': return (r.state ?? 0) >= 0.9 ? 1 : 0.1;
    case 'finType': return (r.finType ?? 0) >= 0.9 ? 1 : 0.1;
    case 'entryStatus': return (r.entryStatus ?? 0) >= 0.8 ? 1 : 0.1;
    case 'installment': return (r.installment ?? 0) >= 0.9 ? 0.9 : 0.1;
    case 'text': return profile.dominant === 'text' && profile.avgLength >= 2 ? 0.8 : 0.2;
  }
}
// Kinds whose content is distinctive enough to suggest a target even when the column name says nothing.
const CONTENT_ONLY: FieldKind[] = ['email', 'document', 'barcode'];

export type Candidate = { field: TargetField; confidence: number; reason: string };
export function scoreColumn(profile: ColumnProfile, fields: TargetField[]): Candidate[] {
  if (isSensitiveColumn(profile.name) || isSystemColumn(profile.name) || profile.dominant === 'empty') return [];
  const out: Candidate[] = [];
  for (const field of fields) {
    const { score, alias } = nameScore(profile.name, field);
    const content = contentScore(profile, field.kind);
    let confidence: number; let reason: string;
    if (score >= 0.5) {
      confidence = content < 0.3 ? score * 0.45 : 0.62 * score + 0.38 * content;
      reason = `Nome "${profile.name}" ≈ "${alias}" (${Math.round(score * 100)}%); conteúdo ${content >= 0.7 ? 'compatível' : content >= 0.3 ? 'parcialmente compatível' : 'incompatível'} com ${field.label.toLowerCase()}.`;
    } else if (CONTENT_ONLY.includes(field.kind) && content >= 0.7) {
      confidence = 0.55 + 0.1 * content; reason = `Nome sem relação direta, mas ${Math.round((profile.ratios[field.kind] ?? 0) * 100)}% dos valores têm o formato de ${field.label.toLowerCase()}.`;
    } else continue;
    if (confidence >= 0.35) out.push({ field, confidence: Math.min(confidence, 0.99), reason });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
export const levelOf = (confidence: number): ColumnMapping['level'] => confidence >= 0.8 ? 'direct' : confidence >= 0.55 ? 'probable' : confidence > 0 ? 'low' : 'none';

// ---- Relationships between source tables ----
export function detectRelationships(tables: SourceTable[], profiles: Map<string, ColumnProfile>): Relationship[] {
  const found: Relationship[] = [];
  const keySets = new Map<string, { table: SourceTable; column: string; values: Set<string> }>();
  for (const table of tables) for (const column of table.columns) {
    const profile = profiles.get(`${tableKey(table)}::${column}`);
    if (!profile || profile.uniqueRatio < 0.99 || profile.nullRatio > 0.05 || table.rows.length < 2) continue;
    const idLike = table.primaryKey?.includes(column) || tokens(column).some(token => ['id', 'codigo', 'chave', 'key'].includes(token));
    if (!idLike) continue;
    keySets.set(`${tableKey(table)}::${column}`, { table, column, values: new Set(table.rows.map(row => row[column]).filter((value): value is string => value !== null)) });
  }
  for (const source of tables) for (const column of source.columns) {
    const columnTokens = tokens(column);
    for (const target of keySets.values()) {
      // A table may reference itself only through an explicit "parent" column (category trees).
      if (target.table === source && (column === target.column || !columnTokens.some(token => ['pai', 'parent', 'superior'].includes(token)))) continue;
      const targetTokens = tokens(target.table.name).flatMap(token => [token, token.replace(/s$/, '')]);
      const related = target.table === source || columnTokens.some(token => targetTokens.includes(token) || targetTokens.includes(token.replace(/s$/, ''))) || column.toLowerCase() === target.column.toLowerCase();
      if (!related) continue;
      const values = [...new Set(sampleValues(source, column, 2000))];
      const sameName = column.toLowerCase() === target.column.toLowerCase();
      // 0/1-only columns are flags, not references (unless they carry the very name of the target key).
      if (values.length === 0 || (!sameName && target.table !== source && values.length <= 2 && values.every(value => value === '0' || value === '1'))) continue;
      const matched = values.filter(value => target.values.has(value)).length / values.length;
      // Orphan references exist in real legacy data: a column with the key's own name is accepted from 50% on, any other related column from 90%.
      if (matched >= (sameName ? 0.5 : 0.9)) found.push({ from: { table: tableKey(source), column }, to: { table: tableKey(target.table), column: target.column }, matchRatio: Math.round(matched * 100) / 100 });
    }
  }
  // Two unique-looking columns reference each other on tiny samples; the child (the table with more rows) is the side that holds the reference.
  const rowsOf = new Map(tables.map(table => [tableKey(table), table.rows.length]));
  return found.filter(relation => !found.some(other => other.from.table === relation.to.table && other.to.table === relation.from.table && ((rowsOf.get(relation.from.table) ?? 0) < (rowsOf.get(other.from.table) ?? 0) || ((rowsOf.get(relation.from.table) ?? 0) === (rowsOf.get(other.from.table) ?? 0) && relation.from.table > other.from.table))));
}

// ---- Mapping ----
export const signatureOfColumns = (columns: string[]) => createHash('sha1').update(columns.map(column => tokens(column).join('_')).sort().join('|')).digest('hex');
export const structureSignature = (table: SourceTable) => signatureOfColumns(table.columns);
export type TemplateLookup = (signature: string, entity: EntityKey) => Record<string, string> | null;

function guessEntity(table: SourceTable, profiles: Map<string, ColumnProfile>) {
  const tableTokens = tokens(table.name).flatMap(token => [token, token.replace(/s$/, '')]);
  const results = ENTITY_KEYS.map(entity => {
    const definition = ENTITIES[entity];
    // A multi-word table name ("categorias financeiras") is more specific than a single word ("categorias").
    const matched = definition.tableHints.filter(hint => tokens(hint).every(token => tableTokens.includes(token)));
    const nameHint = matched.length === 0 ? 0 : matched.some(hint => tokens(hint).length > 1) ? 1 : 0.8;
    const assigned = assignColumns(table, entity, profiles);
    const required = definition.fields.filter(field => field.required);
    const coverage = required.reduce((sum, field) => sum + (assigned.get(field.key)?.confidence ?? 0), 0) / required.length;
    const breadth = Math.min(1, assigned.size / Math.max(3, Math.min(definition.fields.length, 6)));
    const signatureHit = (definition.signature ?? []).some(key => (assigned.get(key)?.confidence ?? 0) >= 0.6);
    const partyHit = definition.party ? (assigned.get(definition.party)?.confidence ?? 0) >= 0.6 : true;
    const score = 0.4 * nameHint + 0.4 * coverage + 0.2 * breadth + (definition.signature ? (signatureHit ? 0.15 : 0) + (partyHit ? 0.1 : 0) : 0);
    return { entity, score, nameHint, coverage, requiredCount: required.length, signatureHit, partyHit, finance: Boolean(definition.signature) };
  }).sort((a, b) => b.score - a.score);
  return results[0];
}

function assignColumns(table: SourceTable, entity: EntityKey, profiles: Map<string, ColumnProfile>) {
  const fields = ENTITIES[entity].fields;
  const pairs: { column: string; candidate: Candidate }[] = [];
  for (const column of table.columns) for (const candidate of scoreColumn(profiles.get(`${tableKey(table)}::${column}`)!, fields)) pairs.push({ column, candidate });
  pairs.sort((a, b) => b.candidate.confidence - a.candidate.confidence);
  const byField = new Map<string, { column: string; confidence: number; reason: string }>(); const usedColumns = new Set<string>();
  for (const { column, candidate } of pairs) {
    if (candidate.confidence < 0.5 || byField.has(candidate.field.key) || usedColumns.has(column)) continue;
    byField.set(candidate.field.key, { column, confidence: candidate.confidence, reason: candidate.reason }); usedColumns.add(column);
  }
  // Elimination: a required field still unplaced is given to the only remaining column whose *content* clearly has its format (e.g. an opaque "pv" holding prices).
  for (const field of fields.filter(item => item.required && !byField.has(item.key) && ['money', 'phone', 'document'].includes(item.kind))) {
    const candidates = table.columns.filter(column => { const profile = profiles.get(`${tableKey(table)}::${column}`)!; return !usedColumns.has(column) && !isSensitiveColumn(column) && !isSystemColumn(column) && (profile.ratios[field.kind] ?? 0) >= 0.7; });
    if (candidates.length === 1) { byField.set(field.key, { column: candidates[0], confidence: 0.52, reason: `Nome "${candidates[0]}" não indica o campo, mas é a única coluna cujo conteúdo tem o formato de ${field.label.toLowerCase()} (decisão por eliminação; revise).` }); usedColumns.add(candidates[0]); }
  }
  return byField;
}

export function suggestMapping(tables: SourceTable[], lookupTemplate?: TemplateLookup): { mapping: MappingDocument; profiles: Map<string, ColumnProfile> } {
  const profiles = new Map<string, ColumnProfile>();
  for (const table of tables) for (const column of table.columns) profiles.set(`${tableKey(table)}::${column}`, profileColumn(table, column));
  const relationships = detectRelationships(tables, profiles);
  const mapping: MappingDocument = { tables: {}, relationships };
  for (const table of tables) {
    const key = tableKey(table);
    const guess = guessEntity(table, profiles);
    // Without a telling table name, a table is only recognised when several required fields are covered with confidence (a lone "name" column proves nothing).
    const recognised = guess.coverage > 0 && (guess.nameHint ? guess.score >= 0.45 - 1e-9 : guess.requiredCount >= 2 && guess.coverage >= 0.8 && (!guess.finance || (guess.signatureHit && guess.partyHit)));
    const entity: EntityKey | 'IGNORE' = recognised ? guess.entity : 'IGNORE';
    const columns: Record<string, ColumnMapping> = {};
    const template = recognised && lookupTemplate ? lookupTemplate(structureSignature(table), guess.entity) : null;
    const assigned = recognised ? assignColumns(table, guess.entity, profiles) : new Map();
    const byColumn = new Map([...assigned].map(([field, value]) => [value.column, { field, ...value }]));
    for (const column of table.columns) {
      const profile = profiles.get(`${key}::${column}`)!;
      if (isSensitiveColumn(column)) { columns[column] = { target: null, confidence: 0, level: 'none', reason: 'Coluna com dado sensível (senha/token/cartão): nunca importada.', source: 'rule', needsReview: false }; continue; }
      if (isSystemColumn(column)) { columns[column] = { target: null, confidence: 0, level: 'none', reason: 'Coluna controlada pelo sistema de origem (id/datas); usada apenas como referência de origem.', source: 'rule', needsReview: false }; continue; }
      const templated = template?.[column];
      if (templated) { columns[column] = { target: templated, confidence: 0.95, level: 'direct', reason: 'Mapeamento aprovado anteriormente para esta mesma estrutura de colunas.', source: 'template', needsReview: false }; continue; }
      const hit = byColumn.get(column);
      if (hit) {
        const alternatives = recognised ? scoreColumn(profile, ENTITIES[guess.entity].fields).filter(item => item.field.key !== hit.field).slice(0, 2).map(item => ({ target: item.field.key, confidence: Math.round(item.confidence * 100) / 100 })) : [];
        columns[column] = { target: hit.field, confidence: Math.round(hit.confidence * 100) / 100, level: levelOf(hit.confidence), reason: hit.reason, source: 'rule', needsReview: hit.confidence < 0.8 || (alternatives[0] !== undefined && hit.confidence - alternatives[0].confidence < 0.1), alternatives };
      } else columns[column] = { target: null, confidence: 0, level: 'none', reason: recognised ? 'Sem correspondência segura no RM Restaurant; não será importada.' : 'Tabela não reconhecida.', source: 'rule', needsReview: false };
    }
    const stem = (token: string) => token.replace(/e?s$/, '');
    const tableStems = tokens(table.name).map(stem);
    const idLike = (column: string) => { const profile = profiles.get(`${key}::${column}`)!; return profile.uniqueRatio >= 0.99 && profile.nullRatio === 0 && tokens(column).some(token => ['id', 'codigo'].includes(token)); };
    const ownKey = (column: string) => tokens(column).some(token => tableStems.includes(stem(token)));
    const candidates = table.columns.filter(idLike);
    const sourceKey = table.primaryKey?.[0] ?? table.columns.find(column => /^id$/i.test(column)) ?? candidates.find(ownKey) ?? candidates[0] ?? null;
    const missingRequired = recognised ? missingRequiredFields(guess.entity, Object.values(columns).flatMap(mapped => mapped.target ? [mapped.target] : [])) : [];
    mapping.tables[key] = {
      key, name: table.name, file: table.file, entity, entityConfidence: Math.round(guess.score * 100) / 100, sourceKey, missingRequired, approved: false,
      entityReason: recognised ? `Tabela "${table.name}" reconhecida como ${ENTITIES[guess.entity].label.toLowerCase()} (${guess.nameHint ? 'nome da tabela, ' : ''}campos obrigatórios cobertos: ${Math.round(guess.coverage * 100)}%).` : `Tabela "${table.name}" não corresponde a nenhum cadastro suportado; será ignorada.`,
      columns,
    };
  }
  return { mapping, profiles };
}
