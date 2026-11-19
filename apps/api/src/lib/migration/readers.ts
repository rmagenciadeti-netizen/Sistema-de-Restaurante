import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { childrenNamed, localName, parseXml, textOf, XmlError, type XmlNode } from './xml';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS_PER_TABLE = 100_000;
const MAX_TABLES = 200;
const MAX_COLUMNS = 300;

export type Row = Record<string, string | null>;
export type SourceFormat = 'csv' | 'json' | 'xml' | 'sql' | 'xlsx';
export type SourceTable = { name: string; file: string; columns: string[]; rows: Row[]; rowCount: number; truncated: boolean; types?: Record<string, string>; primaryKey?: string[] };
export type ReadResult = { format: SourceFormat; encoding: string; tables: SourceTable[]; warnings: string[]; limitations: string[] };

export class UnsupportedFileError extends Error {
  constructor(message: string, readonly code: 'unsupported' | 'corrupted' | 'protected' | 'empty' | 'too_large' = 'unsupported') { super(message); }
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// ---- Format detection ----
export function detectFormat(name: string, buffer: Buffer): SourceFormat {
  if (buffer.length === 0) throw new UnsupportedFileError('O arquivo está vazio.', 'empty');
  if (buffer.length > MAX_FILE_BYTES) throw new UnsupportedFileError(`O arquivo excede o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 'too_large');
  const head = buffer.subarray(0, 16);
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    if (/\.xlsx$/i.test(name) || /\.xlsm$/i.test(name) || zipHasEntry(buffer, 'xl/workbook.xml')) return 'xlsx';
    throw new UnsupportedFileError('Arquivo compactado (ZIP) sem planilha XLSX. Descompacte e envie cada arquivo (CSV, XLSX, JSON, XML ou .sql) individualmente.');
  }
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new UnsupportedFileError('Planilha XLS antiga (BIFF) ou arquivo do Office protegido por senha. No Excel: Arquivo › Salvar como › "Pasta de Trabalho do Excel (.xlsx)" ou "CSV UTF-8", sem senha, e reenvie.', 'protected');
  if (head.toString('latin1').startsWith('SQLite format 3')) throw new UnsupportedFileError('Banco SQLite binário não é lido por esta versão. Gere um dump de texto com: sqlite3 banco.db ".dump" > backup.sql (ou exporte cada tabela em CSV) e envie o arquivo .sql.');
  if (head.toString('latin1').startsWith('PGDMP')) throw new UnsupportedFileError('Backup PostgreSQL em formato customizado (pg_dump -Fc). Gere um dump em texto: pg_dump --format=plain --inserts --data-only -f backup.sql NOME_DO_BANCO, e reenvie.');
  if (head.toString('latin1').startsWith('%PDF') || (head[0] === 0x1f && head[1] === 0x8b)) throw new UnsupportedFileError('Formato não estruturado ou compactado (PDF/GZIP). Descompacte o arquivo, ou peça ao sistema de origem uma exportação em CSV, XLSX, JSON, XML ou dump SQL em texto (mysqldump --skip-extended-insert / pg_dump --format=plain).');
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0) && !(sample[0] === 0xff && sample[1] === 0xfe) && !(sample[0] === 0xfe && sample[1] === 0xff)) throw new UnsupportedFileError('Arquivo binário, criptografado ou proprietário sem estrutura legível (comum em backups .bak/.fbk/.gdb/.mdb). Peça ao fornecedor do sistema antigo uma exportação em CSV, XLSX, JSON, XML ou dump SQL em texto.');
  const { text } = decodeText(sample);
  const trimmed = text.replace(/^\ufeff/, '').trimStart();
  if (/\.sql$/i.test(name) || /^(--|\/\*|create\s|insert\s|copy\s|set\s|drop\s|begin\b|use\s|pragma\s)/i.test(trimmed) || /\bINSERT\s+INTO\b/i.test(text)) return 'sql';
  if (/\.json$/i.test(name) || /^[[{]/.test(trimmed)) return 'json';
  if (/\.xml$/i.test(name) || /^<\?xml|^<[a-z]/i.test(trimmed)) return 'xml';
  return 'csv';
}

export function decodeText(buffer: Buffer, hint?: string): { text: string; encoding: string } {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { text: buffer.toString('utf8', 3), encoding: 'utf-8' };
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: buffer.toString('utf16le', 2), encoding: 'utf-16le' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) { const swapped = Buffer.from(buffer.subarray(2)); swapped.swap16(); return { text: swapped.toString('utf16le'), encoding: 'utf-16be' }; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' }; } catch { /* Not valid UTF-8: fall through to a legacy code page. */ }
  const label = hint && /^[\w-]+$/.test(hint) ? hint : 'windows-1252';
  try { return { text: new TextDecoder(label).decode(buffer), encoding: label.toLowerCase() }; } catch { return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' }; }
}

// ---- Matrix -> table (shared by CSV and XLSX) ----
const looksNumeric = (value: string) => /^[-+(]?(?:R\$\s*)?\d[\d.,]*\)?$/.test(value.trim());
function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, index) => {
    const base = cell.trim().replace(/\s+/g, ' ') || `coluna_${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1; seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base}_${count}`;
  });
}
export function tableFromMatrix(name: string, file: string, matrix: (string | null)[][], warnings: string[]): SourceTable | null {
  const rows = matrix.filter(cells => cells.some(cell => cell !== null && cell.trim() !== ''));
  if (rows.length === 0) return null;
  // Width is measured with a loop: spreading 100k+ rows into Math.max overflows the call stack.
  let widest = 0; for (const cells of rows) widest = Math.max(widest, cells.length);
  const first = rows[0].map(cell => cell ?? '');
  const headerless = first.length > 0 && first.some(cell => cell.trim() !== '') && first.every(cell => cell.trim() === '' || looksNumeric(cell)) && first.filter(cell => cell.trim() !== '').length >= 2;
  const width = Math.min(widest, MAX_COLUMNS);
  const columns = headerless ? Array.from({ length: width }, (_, index) => `coluna_${index + 1}`) : uniqueHeaders(Array.from({ length: width }, (_, index) => first[index] ?? ''));
  if (headerless) warnings.push(`Tabela "${name}": a primeira linha parece ser dado, não cabeçalho; colunas nomeadas como coluna_N.`);
  const body = headerless ? rows : rows.slice(1);
  let irregular = 0;
  const mapped: Row[] = [];
  for (const cells of body.slice(0, MAX_ROWS_PER_TABLE)) {
    if (cells.length !== width) irregular++;
    const row: Row = {};
    columns.forEach((column, index) => { const cell = cells[index]; row[column] = cell === undefined || cell === null || cell === '' ? null : cell; });
    mapped.push(row);
  }
  if (irregular > 0) warnings.push(`Tabela "${name}": ${irregular} linha(s) com número de colunas diferente do cabeçalho (preenchidas/cortadas).`);
  return { name, file, columns, rows: mapped, rowCount: mapped.length, truncated: body.length > MAX_ROWS_PER_TABLE };
}

// ---- CSV ----
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(0, 25);
  let best = ','; let bestScore = 0;
  for (const delimiter of [';', ',', '\t', '|']) {
    const counts = lines.map(line => { let quoted = false; let count = 0; for (const char of line) { if (char === '"') quoted = !quoted; else if (char === delimiter && !quoted) count++; } return count; });
    const mode = [...new Set(counts)].sort((a, b) => counts.filter(c => c === b).length - counts.filter(c => c === a).length)[0] ?? 0;
    const score = mode === 0 ? 0 : (counts.filter(count => count === mode).length / Math.max(lines.length, 1)) * (1 + Math.min(mode, 20) / 20);
    if (score > bestScore + 1e-9) { best = delimiter; bestScore = score; }
  }
  return best;
}
export function parseCsvText(text: string, delimiter: string): { rows: string[][]; unterminated: boolean } {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let touched = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += char;
    } else if (char === '"' && field === '') { quoted = true; touched = true; }
    else if (char === delimiter) { row.push(field); field = ''; touched = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (touched || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; touched = false;
    } else { field += char; touched = true; }
  }
  if (touched || field !== '') { row.push(field); rows.push(row); }
  return { rows, unterminated: quoted };
}
function readCsv(name: string, buffer: Buffer): ReadResult {
  const { text, encoding } = decodeText(buffer);
  const body = text.replace(/^\ufeff/, '');
  const delimiter = detectDelimiter(body);
  const parsed = parseCsvText(body, delimiter);
  const warnings: string[] = [];
  if (parsed.unterminated) warnings.push('Aspas sem fechamento no final do arquivo: o arquivo pode estar truncado.');
  const table = tableFromMatrix(name.replace(/\.[^.]+$/, '') || 'dados', name, parsed.rows, warnings);
  if (!table) throw new UnsupportedFileError('Nenhuma linha de dados foi encontrada.', 'empty');
  if (table.truncated) warnings.push(`Tabela "${table.name}" limitada às primeiras ${MAX_ROWS_PER_TABLE} linhas.`);
  return { format: 'csv', encoding, tables: [table], warnings: [`Separador detectado: ${delimiter === '\t' ? 'TAB' : `"${delimiter}"`}.`, ...warnings], limitations: [] };
}

// ---- JSON ----
const scalar = (value: unknown): string | null => value === null || value === undefined ? null : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
function flattenRecord(record: Record<string, unknown>): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(inner => inner === null || typeof inner !== 'object')) for (const [innerKey, inner] of Object.entries(value)) row[`${key}.${innerKey}`] = scalar(inner);
    else row[key] = scalar(value);
  }
  return row;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function jsonTables(value: unknown, name: string, file: string, out: SourceTable[], depth = 0) {
  if (out.length >= MAX_TABLES) return;
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    if (records.length > 0 && records.length >= value.length * 0.8) {
      const rows = records.slice(0, MAX_ROWS_PER_TABLE).map(flattenRecord);
      const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, MAX_COLUMNS);
      out.push({ name, file, columns, rows: rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), rowCount: rows.length, truncated: records.length > MAX_ROWS_PER_TABLE });
    }
    return;
  }
  if (!isRecord(value) || depth > 3) return;
  const nested = Object.entries(value).filter(([, inner]) => Array.isArray(inner) || isRecord(inner));
  const before = out.length;
  for (const [key, inner] of nested) jsonTables(inner, key, file, out, depth + 1);
  if (out.length === before && Object.keys(value).length > 0 && depth === 0) { const row = flattenRecord(value); out.push({ name, file, columns: Object.keys(row), rows: [row], rowCount: 1, truncated: false }); }
}
function readJson(name: string, buffer: Buffer): ReadResult {
  const { text, encoding } = decodeText(buffer);
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\ufeff/, '')); } catch { throw new UnsupportedFileError('JSON inválido ou incompleto (arquivo truncado ou corrompido).', 'corrupted'); }
  const tables: SourceTable[] = []; jsonTables(value, name.replace(/\.[^.]+$/, '') || 'dados', name, tables);
  if (tables.length === 0) throw new UnsupportedFileError('O JSON não contém listas de registros (objetos) reconhecíveis.');
  return { format: 'json', encoding, tables, warnings: [], limitations: [] };
}

// ---- XML ----
function readXml(name: string, buffer: Buffer): ReadResult {
  const declared = /^<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(buffer.subarray(0, 200).toString('latin1'))?.[1];
  const { text, encoding } = decodeText(buffer, declared);
  let root: XmlNode;
  try { root = parseXml(text.replace(/^\ufeff/, '')); } catch (error) { if (error instanceof XmlError) throw new UnsupportedFileError(error.message, 'corrupted'); throw error; }
  const byName = new Map<string, XmlNode[]>();
  const visit = (node: XmlNode) => { for (const child of node.children) { (byName.get(localName(child.name)) ?? byName.set(localName(child.name), []).get(localName(child.name))!).push(child); visit(child); } };
  visit(root);
  const isLeafRecord = (node: XmlNode) => node.children.length + Object.keys(node.attrs).length >= 1 && node.children.every(child => child.children.length === 0);
  const build = (tag: string, nodes: XmlNode[]): SourceTable => {
    const rows = nodes.slice(0, MAX_ROWS_PER_TABLE).map(node => {
      const row: Row = {};
      for (const [key, value] of Object.entries(node.attrs)) row[key] = value;
      for (const child of node.children) row[localName(child.name)] = textOf(child).trim() || null;
      return row;
    });
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, MAX_COLUMNS);
    return { name: tag, file: name, columns, rows: rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), rowCount: rows.length, truncated: nodes.length > MAX_ROWS_PER_TABLE };
  };
  let tables = [...byName].filter(([, nodes]) => nodes.length >= 2 && nodes.every(isLeafRecord)).slice(0, MAX_TABLES).map(([tag, nodes]) => build(tag, nodes));
  if (tables.length === 0) tables = [...byName].filter(([, nodes]) => nodes.length === 1 && isLeafRecord(nodes[0]) && nodes[0].children.length >= 2).slice(0, 5).map(([tag, nodes]) => build(tag, nodes));
  if (tables.length === 0) throw new UnsupportedFileError('O XML não contém registros repetidos reconhecíveis (elementos com campos simples).');
  return { format: 'xml', encoding, tables, warnings: [], limitations: [] };
}

// ---- SQL dumps (parsed statically; never executed) ----
const cleanIdent = (value: string) => { const parts = value.trim().split('.').map(part => part.trim().replace(/^[`"[]|[`"\]]$/g, '')); return parts[parts.length - 1]; };

function splitStatements(text: string, mysql: boolean): { statements: string[]; copies: { header: string; lines: string[] }[]; incomplete: boolean } {
  const statements: string[] = []; const copies: { header: string; lines: string[] }[] = [];
  let i = 0; let start = 0; const length = text.length;
  const flush = (end: number) => { const statement = text.slice(start, end).trim(); if (statement) statements.push(statement); };
  while (i < length) {
    const char = text[i];
    if (char === '-' && text[i + 1] === '-') { const end = text.indexOf('\n', i); const stop = end < 0 ? length : end; if (text.slice(start, i).trim() === '') start = stop; i = stop; continue; }
    if (char === '#' && mysql && text.slice(start, i).trim() === '') { const end = text.indexOf('\n', i); i = start = end < 0 ? length : end; continue; }
    if (char === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? length : end + 2; if (text.slice(start, i).trim() === '') start = stop; i = stop; continue; }
    if (char === "'" || char === '"' || char === '`') {
      i++;
      while (i < length) {
        if (text[i] === '\\' && mysql && char === "'") { i += 2; continue; }
        if (text[i] === char) { if (text[i + 1] === char) { i += 2; continue; } break; }
        i++;
      }
      i++; continue;
    }
    if (char === '$') { const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40)); if (tag) { const end = text.indexOf(tag[0], i + tag[0].length); i = end < 0 ? length : end + tag[0].length; continue; } }
    if (char === ';') {
      const statement = text.slice(start, i).trim();
      if (/^COPY\s/i.test(statement) && /FROM\s+stdin\s*$/i.test(statement)) {
        let cursor = text.indexOf('\n', i); cursor = cursor < 0 ? length : cursor + 1; const lines: string[] = [];
        while (cursor < length) { const end = text.indexOf('\n', cursor); const line = text.slice(cursor, end < 0 ? length : end).replace(/\r$/, ''); cursor = end < 0 ? length : end + 1; if (line === '\\.') break; lines.push(line); }
        copies.push({ header: statement, lines }); i = start = cursor; continue;
      }
      if (statement) statements.push(statement);
      start = ++i; continue;
    }
    i++;
  }
  const tail = text.slice(start).trim();
  const incomplete = tail !== '' && !/^(--|\/\*)/.test(tail);
  return { statements, copies, incomplete };
}

function parseTuples(source: string, start: number, mysql: boolean): { rows: (string | null)[][]; complete: boolean } {
  const rows: (string | null)[][] = []; let i = start; const length = source.length;
  while (i < length) {
    while (i < length && /[\s,]/.test(source[i])) i++;
    if (source[i] !== '(') return { rows, complete: i >= length };
    i++;
    const values: (string | null)[] = [];
    for (;;) {
      while (i < length && /\s/.test(source[i])) i++;
      if (i >= length) return { rows, complete: false };
      if (source[i] === "'") {
        let value = ''; i++;
        for (;;) {
          if (i >= length) return { rows, complete: false };
          const char = source[i];
          if (char === '\\' && mysql) { const next = source[i + 1]; value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next === '0' ? '\0' : next; i += 2; continue; }
          if (char === "'") { if (source[i + 1] === "'") { value += "'"; i += 2; continue; } i++; break; }
          value += char; i++;
        }
        values.push(value);
      } else {
        let depth = 0; const begin = i;
        while (i < length && (depth > 0 || (source[i] !== ',' && source[i] !== ')'))) {
          if (source[i] === '(') depth++; else if (source[i] === ')') depth--;
          else if (source[i] === "'") { i++; while (i < length && source[i] !== "'") i++; }
          i++;
        }
        if (i >= length) return { rows, complete: false };
        const raw = source.slice(begin, i).trim();
        values.push(/^null$/i.test(raw) ? null : raw);
      }
      while (i < length && /\s/.test(source[i])) i++;
      if (source[i] === ',') { i++; continue; }
      if (source[i] === ')') { i++; break; }
      return { rows, complete: false };
    }
    rows.push(values);
  }
  return { rows, complete: true };
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []; let depth = 0; let quote = ''; let current = '';
  for (const char of body) {
    if (quote) { current += char; if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === '(') depth++; else if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function readSql(name: string, buffer: Buffer): ReadResult {
  const { text, encoding } = decodeText(buffer);
  const mysql = /mysqldump|ENGINE\s*=|`[A-Za-z_]\w*`/i.test(text.slice(0, 200_000));
  const { statements, copies, incomplete } = splitStatements(text.replace(/^\ufeff/, ''), mysql);
  const tables = new Map<string, SourceTable>(); const warnings: string[] = []; const limitations: string[] = [];
  const table = (rawName: string) => { const key = cleanIdent(rawName); let value = tables.get(key); if (!value) { value = { name: key, file: name, columns: [], rows: [], rowCount: 0, truncated: false, types: {}, primaryKey: [] }; tables.set(key, value); } return value; };
  const addRow = (target: SourceTable, columns: string[], values: (string | null)[]) => {
    if (target.rows.length >= MAX_ROWS_PER_TABLE) { target.truncated = true; return; }
    target.rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null])));
  };
  for (const statement of statements) {
    const create = /^CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i.exec(statement);
    if (create) {
      const target = table(create[1]);
      const open = statement.indexOf('(', create[0].length - 1);
      let depth = 0; let end = -1; let quote = '';
      for (let i = open; i < statement.length; i++) { const c = statement[i]; if (quote) { if (c === quote) quote = ''; continue; } if (c === "'" || c === '"' || c === '`') quote = c; else if (c === '(') depth++; else if (c === ')' && --depth === 0) { end = i; break; } }
      if (end < 0) continue;
      for (const definition of splitTopLevel(statement.slice(open + 1, end))) {
        const def = definition.trim();
        const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(def);
        if (pk) { target.primaryKey = pk[1].split(',').map(cleanIdent); continue; }
        if (/^(?:CONSTRAINT|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i.test(def)) continue;
        const column = /^(`[^`]+`|"[^"]+"|\[[^\]]+\]|\S+)\s+([A-Za-z]+(?:\s*\([^)]*\))?)/.exec(def);
        if (!column) continue;
        const columnName = cleanIdent(column[1]);
        target.columns.push(columnName); target.types![columnName] = column[2].toLowerCase();
        if (/\bPRIMARY\s+KEY\b/i.test(def)) target.primaryKey = [columnName];
      }
      continue;
    }
    const insert = /^INSERT\s+(?:IGNORE\s+|OR\s+\w+\s+)?INTO\s+([^\s(]+)\s*(\(([^)]*)\))?\s*(?:VALUES?)\s*/i.exec(statement);
    if (insert) {
      const target = table(insert[1]);
      const listed = insert[3] ? insert[3].split(',').map(cleanIdent) : null;
      const parsed = parseTuples(statement, insert[0].length, mysql);
      if (!parsed.complete) warnings.push(`Comando INSERT de "${target.name}" termina de forma inesperada; apenas as linhas completas foram lidas.`);
      const columns = listed ?? (target.columns.length > 0 ? target.columns : Array.from({ length: parsed.rows[0]?.length ?? 0 }, (_, index) => `coluna_${index + 1}`));
      if (target.columns.length === 0) target.columns = columns;
      if (listed) for (const column of listed) if (!target.columns.includes(column)) target.columns.push(column);
      for (const values of parsed.rows) { target.rowCount++; addRow(target, columns, values); }
    }
  }
  for (const copy of copies) {
    const header = /^COPY\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(copy.header);
    if (!header) continue;
    const target = table(header[1]);
    const columns = header[2] ? header[2].split(',').map(cleanIdent) : target.columns;
    if (target.columns.length === 0) target.columns = columns;
    for (const line of copy.lines) { target.rowCount++; addRow(target, columns, line.split('\t').map(cell => cell === '\\N' ? null : cell.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'))); }
  }
  if (incomplete) warnings.push('O arquivo termina no meio de um comando SQL (backup incompleto?). O último comando foi descartado.');
  const result = [...tables.values()].filter(item => item.columns.length > 0 || item.rows.length > 0);
  for (const item of result) {
    if (item.rows.length === 0) warnings.push(`Tabela "${item.name}" tem estrutura mas nenhum dado no arquivo.`);
    if (item.truncated) warnings.push(`Tabela "${item.name}" limitada às primeiras ${MAX_ROWS_PER_TABLE} linhas.`);
  }
  const withData = result.filter(item => item.rows.length > 0);
  if (withData.length === 0) throw new UnsupportedFileError('O dump SQL não contém comandos INSERT/COPY com dados legíveis (apenas estrutura ou formato não suportado).');
  limitations.push('Dump SQL lido apenas de forma estática (INSERT/COPY); nenhum comando do arquivo foi executado. Views, triggers e procedimentos são ignorados.');
  return { format: 'sql', encoding, tables: result.slice(0, MAX_TABLES), warnings, limitations };
}

// ---- XLSX (ZIP + OOXML) ----
type ZipEntry = { name: string; read: () => Buffer };
function zipEntries(buffer: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new UnsupportedFileError('Arquivo ZIP/XLSX corrompido ou incompleto.', 'corrupted');
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16);
  if (count > 5000) throw new UnsupportedFileError('ZIP com entradas demais.', 'corrupted');
  const entries: ZipEntry[] = []; let declaredTotal = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new UnsupportedFileError('Diretório do ZIP corrompido.', 'corrupted');
    const flags = buffer.readUInt16LE(offset + 8); const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20); const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42); const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    declaredTotal += size;
    if (size > 64 * 1024 * 1024 || declaredTotal > 200 * 1024 * 1024) throw new UnsupportedFileError('Conteúdo descompactado excede o limite de segurança.', 'too_large');
    if (flags & 1) throw new UnsupportedFileError('Planilha protegida por senha. Remova a senha e reenvie.', 'protected');
    entries.push({ name, read: () => {
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new UnsupportedFileError('Entrada do ZIP corrompida.', 'corrupted');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method !== 8) throw new UnsupportedFileError('Método de compressão do ZIP não suportado.');
      try { return inflateRawSync(data, { maxOutputLength: size + 1 }); } catch { throw new UnsupportedFileError('Entrada do ZIP corrompida ou maior que o declarado.', 'corrupted'); }
    } });
  }
  return entries;
}
const zipHasEntry = (buffer: Buffer, name: string) => { try { return zipEntries(buffer).some(entry => entry.name === name); } catch { return false; } };

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const columnIndex = (ref: string) => { let index = 0; for (const char of /^[A-Z]+/i.exec(ref)?.[0] ?? '') index = index * 26 + (char.toUpperCase().charCodeAt(0) - 64); return index - 1; };
function serialToDate(serial: number): string {
  const date = new Date(Math.round((serial - 25569) * 86_400_000));
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
function readXlsx(name: string, buffer: Buffer): ReadResult {
  const entries = zipEntries(buffer); const find = (path: string) => entries.find(entry => entry.name === path);
  const workbookEntry = find('xl/workbook.xml');
  if (!workbookEntry) throw new UnsupportedFileError('Arquivo XLSX sem workbook (corrompido ou não é uma planilha).', 'corrupted');
  const text = (entry?: ZipEntry) => (entry ? decodeText(entry.read()).text : '');
  const workbook = parseXml(text(workbookEntry));
  const rels = new Map<string, string>();
  const relsEntry = find('xl/_rels/workbook.xml.rels');
  if (relsEntry) for (const rel of parseXml(text(relsEntry)).children.flatMap(node => node.children)) rels.set(rel.attrs.Id, rel.attrs.Target);
  const sharedEntry = find('xl/sharedStrings.xml');
  const shared = sharedEntry ? (parseXml(text(sharedEntry)).children[0]?.children ?? []).map(item => textOf(item)) : [];
  const dateStyles = new Set<number>();
  const stylesEntry = find('xl/styles.xml');
  if (stylesEntry) {
    const styles = parseXml(text(stylesEntry)).children[0];
    const custom = new Set<number>();
    for (const format of childrenNamed(styles, 'numFmts').flatMap(node => node.children)) if (/[dmyh]/i.test((format.attrs.formatCode ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))) custom.add(Number(format.attrs.numFmtId));
    (childrenNamed(styles, 'cellXfs')[0]?.children ?? []).forEach((xf, index) => { const id = Number(xf.attrs.numFmtId); if (BUILTIN_DATE_FORMATS.has(id) || custom.has(id)) dateStyles.add(index); });
  }
  const sheets = childrenNamed(workbook.children[0], 'sheets')[0]?.children ?? [];
  const tables: SourceTable[] = []; const warnings: string[] = [];
  for (const sheet of sheets.slice(0, MAX_TABLES)) {
    const target = rels.get(sheet.attrs['r:id']) ?? rels.get(sheet.attrs.id);
    const entry = target ? find(target.startsWith('/') ? target.slice(1) : `xl/${target}`) : undefined;
    if (!entry) { warnings.push(`Planilha "${sheet.attrs.name}" sem conteúdo legível.`); continue; }
    const sheetRoot = parseXml(text(entry)).children[0];
    const matrix: (string | null)[][] = [];
    for (const row of childrenNamed(childrenNamed(sheetRoot, 'sheetData')[0] ?? sheetRoot, 'row')) {
      const cells: (string | null)[] = [];
      for (const cell of childrenNamed(row, 'c')) {
        const type = cell.attrs.t; const raw = childrenNamed(cell, 'v')[0]?.text ?? '';
        let value: string | null;
        if (type === 's') value = shared[Number(raw)] ?? null;
        else if (type === 'inlineStr') value = textOf(childrenNamed(cell, 'is')[0] ?? cell);
        else if (type === 'str') value = raw;
        else if (type === 'e') value = null;
        else if (raw === '') value = null;
        else if (type === 'b') value = raw;
        else { const number = Number(raw); value = !Number.isFinite(number) ? raw : dateStyles.has(Number(cell.attrs.s)) && number > 0 ? serialToDate(number) : String(parseFloat(number.toPrecision(15))); }
        const index = cell.attrs.r ? columnIndex(cell.attrs.r) : cells.length;
        // A forged cell reference (e.g. ZZZZZZ1) must not allocate a huge sparse row.
        if (index >= 0 && index < MAX_COLUMNS) cells[index] = value;
      }
      matrix.push(Array.from(cells, cell => cell ?? null));
    }
    const table = tableFromMatrix(sheet.attrs.name || `planilha_${tables.length + 1}`, name, matrix, warnings);
    if (table) { tables.push(table); if (table.truncated) warnings.push(`Planilha "${table.name}" limitada às primeiras ${MAX_ROWS_PER_TABLE} linhas.`); }
  }
  if (tables.length === 0) throw new UnsupportedFileError('Nenhuma planilha com dados foi encontrada.', 'empty');
  return { format: 'xlsx', encoding: 'utf-8', tables, warnings, limitations: ['Fórmulas são lidas pelo último valor calculado salvo no arquivo; imagens incorporadas não são extraídas.'] };
}

export function readSource(name: string, buffer: Buffer): ReadResult {
  const format = detectFormat(name, buffer);
  const result = format === 'csv' ? readCsv(name, buffer) : format === 'json' ? readJson(name, buffer) : format === 'xml' ? readXml(name, buffer) : format === 'sql' ? readSql(name, buffer) : readXlsx(name, buffer);
  return result;
}
