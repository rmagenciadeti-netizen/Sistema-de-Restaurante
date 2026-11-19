import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { pipeline as nodePipeline } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

// Backup file container. Plain text is NDJSON: a header (identity), one line per row, a footer (per-table counts + hashes). The footer is written last,
// so a truncated file is detected. The NDJSON is gzipped and, when a key is configured, sealed with AES-256-GCM: RMBK1 | iv(12) | ciphertext | tag(16).
// Row payloads are the exact text PostgreSQL produced (to_jsonb), never re-serialised, so numbers/dates survive byte for byte.
const MAGIC_PLAIN = Buffer.from('RMBK0');
const MAGIC_SEALED = Buffer.from('RMBK1');
const TAG_BYTES = 16; const IV_BYTES = 12;
const ROW_PREFIX = (table: string) => `{"t":${JSON.stringify(table)},"r":`;

export class BackupFileError extends Error {
  constructor(readonly code: 'STORAGE' | 'MISSING' | 'CORRUPT' | 'INCOMPLETE' | 'IDENTITY' | 'KEY', message: string) { super(message); }
}

export type BackupHeader = { type: 'header'; format: 'rm-migration-backup'; version: 1; backupId: string; tenantId: string; sessionId: string; createdAt: string; engineVersion: string; database: BackupDatabase; tables: string[] };
export type TableDigest = { count: number; sha256: string };
export type BackupFooter = { type: 'footer'; totalRows: number; tables: Record<string, TableDigest> };
export type BackupDatabase = { name: string; host: string; fingerprint: string };
export type BackupIdentity = Pick<BackupHeader, 'backupId' | 'tenantId' | 'sessionId'>;

export function parseEncryptionKey(configured: string | undefined): Buffer | null {
  if (!configured) return null;
  const key = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new BackupFileError('KEY', 'MIGRATION_BACKUP_ENCRYPTION_KEY deve ter 32 bytes (hex ou base64).');
  return key;
}

// Incremental per-table digest: sha256 over every row text followed by "\n", in the order rows are written/read.
export class DigestSet {
  private readonly hashes = new Map<string, { hash: ReturnType<typeof createHash>; count: number }>();
  add(table: string, rowText: string) {
    let entry = this.hashes.get(table); if (!entry) { entry = { hash: createHash('sha256'), count: 0 }; this.hashes.set(table, entry); }
    entry.hash.update(rowText); entry.hash.update('\n'); entry.count += 1;
  }
  result(tables: string[]): Record<string, TableDigest> {
    return Object.fromEntries(tables.map(table => { const entry = this.hashes.get(table); return [table, { count: entry?.count ?? 0, sha256: (entry?.hash ?? createHash('sha256')).digest('hex') }]; }));
  }
}

export type BackupWriter = { row(table: string, rowText: string): Promise<void> };

export async function writeBackupFile(path: string, key: Buffer | null, header: BackupHeader, produce: (writer: BackupWriter) => Promise<void>): Promise<{ size: number; sha256: string; footer: BackupFooter }> {
  const temporary = `${path}.partial`;
  const digests = new DigestSet(); let totalRows = 0;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const gzip = createGzip(); const out = createWriteStream(temporary, { mode: 0o600 });
    const iv = key ? randomBytes(IV_BYTES) : null;
    const sealer = key && iv ? createCipheriv('aes-256-gcm', key, iv) : null;
    out.write(sealer && iv ? Buffer.concat([MAGIC_SEALED, iv]) : MAGIC_PLAIN);
    const done = sealer ? pipeline(gzip, sealer, out) : pipeline(gzip, out);
    done.catch(() => undefined);
    const write = async (line: string) => { if (!gzip.write(`${line}\n`)) await Promise.race([once(gzip, 'drain'), done]); };
    try {
      await write(JSON.stringify(header));
      await produce({ row: async (table, text) => { if (!header.tables.includes(table)) throw new BackupFileError('CORRUPT', `Tabela fora do escopo do backup: ${table}`); digests.add(table, text); totalRows += 1; await write(`${ROW_PREFIX(table)}${text}}`); } });
      const footer: BackupFooter = { type: 'footer', totalRows, tables: digests.result(header.tables) };
      await write(JSON.stringify(footer));
      gzip.end(); await done;
      if (sealer) await appendFile(temporary, sealer.getAuthTag());
      await rename(temporary, path);
      return { size: (await stat(path)).size, sha256: await hashFile(path), footer };
    } catch (error) { gzip.destroy(); out.destroy(); throw error; }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof BackupFileError) throw error;
    throw new BackupFileError('STORAGE', `Falha ao gravar o arquivo de backup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function* readLines(path: string, key: Buffer | null): AsyncGenerator<string> {
  let handle; let size: number;
  try { handle = await open(path, 'r'); size = (await handle.stat()).size; }
  catch (error) { throw new BackupFileError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'STORAGE', `Arquivo de backup indisponível: ${(error as Error).message}`); }
  try {
    const magic = Buffer.alloc(MAGIC_PLAIN.length); await handle.read(magic, 0, magic.length, 0);
    const sealed = magic.equals(MAGIC_SEALED);
    if (!sealed && !magic.equals(MAGIC_PLAIN)) throw new BackupFileError('CORRUPT', 'Cabeçalho do arquivo de backup inválido.');
    let start = magic.length; let end = size - 1; const stages: NodeJS.ReadWriteStream[] = [];
    if (sealed) {
      if (!key) throw new BackupFileError('KEY', 'O backup está criptografado e MIGRATION_BACKUP_ENCRYPTION_KEY não está configurada.');
      if (size < magic.length + IV_BYTES + TAG_BYTES) throw new BackupFileError('INCOMPLETE', 'Arquivo de backup truncado.');
      const iv = Buffer.alloc(IV_BYTES); await handle.read(iv, 0, IV_BYTES, magic.length);
      const tag = Buffer.alloc(TAG_BYTES); await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
      start += IV_BYTES; end = size - TAG_BYTES - 1; stages.push(decipher);
    }
    const gunzip = createGunzip(); stages.push(gunzip);
    // callback-style pipeline destroys every stage on the first error, so a failed GCM tag or a bad gzip stream surfaces as a rejected iteration.
    (nodePipeline as unknown as (streams: unknown[], done: () => void) => void)([createReadStream(path, { start, end }), ...stages], () => undefined);
    const lines: string[] = []; let pending = ''; const decoder = new StringDecoder('utf8');
    try {
      for await (const chunk of gunzip) {
        pending += decoder.write(chunk as Buffer);
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) { lines.push(pending.slice(0, index)); pending = pending.slice(index + 1); }
        while (lines.length) yield lines.shift()!;
      }
    } catch (error) { throw new BackupFileError('CORRUPT', `Arquivo de backup corrompido: ${error instanceof Error ? error.message : String(error)}`); }
    pending += decoder.end();
    if (pending.length) yield pending;
  } finally { await handle.close(); }
}

export type ParsedLine = { kind: 'header'; header: BackupHeader } | { kind: 'row'; table: string; text: string } | { kind: 'footer'; footer: BackupFooter };
function parseLine(line: string): ParsedLine {
  if (line.startsWith('{"t":')) {
    const split = line.indexOf(',"r":'); if (split < 0 || !line.endsWith('}')) throw new BackupFileError('CORRUPT', 'Linha de registro malformada.');
    return { kind: 'row', table: JSON.parse(line.slice(5, split)) as string, text: line.slice(split + 5, -1) };
  }
  const parsed = JSON.parse(line) as { type?: string };
  if (parsed.type === 'header') return { kind: 'header', header: parsed as BackupHeader };
  if (parsed.type === 'footer') return { kind: 'footer', footer: parsed as BackupFooter };
  throw new BackupFileError('CORRUPT', 'Linha desconhecida no arquivo de backup.');
}

// Streams the backup. Throws BackupFileError on any structural problem; the header is validated against the expected identity before rows are yielded
// and the footer (counts + hashes recomputed while reading) must match, so the whole file has been checked once the generator completes.
export async function* readBackupRows(path: string, key: Buffer | null, expected?: BackupIdentity): AsyncGenerator<{ table: string; text: string }, { header: BackupHeader; footer: BackupFooter }> {
  let header: BackupHeader | null = null; let footer: BackupFooter | null = null; const digests = new DigestSet(); let rows = 0;
  try {
    for await (const line of readLines(path, key)) {
      let parsed: ParsedLine;
      try { parsed = parseLine(line); } catch (error) { throw error instanceof BackupFileError ? error : new BackupFileError('CORRUPT', 'Linha ilegível no arquivo de backup.'); }
      if (!header) {
        if (parsed.kind !== 'header' || parsed.header.format !== 'rm-migration-backup' || parsed.header.version !== 1) throw new BackupFileError('CORRUPT', 'Arquivo sem cabeçalho de backup válido.');
        header = parsed.header;
        if (expected && (header.backupId !== expected.backupId || header.tenantId !== expected.tenantId || header.sessionId !== expected.sessionId)) throw new BackupFileError('IDENTITY', 'O arquivo pertence a outra empresa, sessão ou operação de backup.');
        continue;
      }
      if (footer) throw new BackupFileError('CORRUPT', 'Conteúdo após o rodapé do backup.');
      if (parsed.kind === 'footer') { footer = parsed.footer; continue; }
      if (parsed.kind !== 'row' || !header.tables.includes(parsed.table)) throw new BackupFileError('CORRUPT', 'Registro inesperado no arquivo de backup.');
      digests.add(parsed.table, parsed.text); rows += 1;
      yield { table: parsed.table, text: parsed.text };
    }
  } catch (error) {
    if (error instanceof BackupFileError) throw error;
    throw new BackupFileError('CORRUPT', `Arquivo de backup ilegível: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!header) throw new BackupFileError('INCOMPLETE', 'Arquivo de backup vazio.');
  if (!footer) throw new BackupFileError('INCOMPLETE', 'Arquivo de backup incompleto (rodapé ausente).');
  const actual = digests.result(header.tables);
  if (footer.totalRows !== rows) throw new BackupFileError('CORRUPT', 'Total de registros do rodapé difere do conteúdo.');
  for (const table of header.tables) if (actual[table].count !== footer.tables[table]?.count || actual[table].sha256 !== footer.tables[table]?.sha256) throw new BackupFileError('CORRUPT', `Conteúdo da tabela ${table} não confere com o rodapé.`);
  return { header, footer };
}

export type IntegrityResult = { header: BackupHeader; footer: BackupFooter; size: number; sha256: string };
// Full integrity check: the file hash must equal the recorded one and the whole content must decode and match its own footer.
export async function verifyBackupFile(path: string, key: Buffer | null, recorded: { sha256: string; size?: number | null }, expected: BackupIdentity): Promise<IntegrityResult> {
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) { throw new BackupFileError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'STORAGE', `Arquivo de backup não encontrado: ${(error as Error).message}`); }
  if (recorded.size != null && size !== recorded.size) throw new BackupFileError('CORRUPT', 'Tamanho do arquivo difere do registrado.');
  const sha256 = await hashFile(path);
  if (sha256 !== recorded.sha256) throw new BackupFileError('CORRUPT', 'O hash SHA-256 do arquivo difere do registrado (arquivo alterado ou corrompido).');
  const reader = readBackupRows(path, key, expected);
  for (;;) { const next = await reader.next(); if (next.done) return { ...next.value, size, sha256 }; }
}
