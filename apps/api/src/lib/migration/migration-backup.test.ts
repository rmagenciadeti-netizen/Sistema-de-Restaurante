import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BackupFileError, parseEncryptionKey, readBackupRows, verifyBackupFile, writeBackupFile, type BackupHeader } from './backup-file';
import { BACKUP_MODELS, tableOf } from './backup';

const key = randomBytes(32);
const tables = ['Customer', 'Product'];
const rows = [
  ['Customer', '{"id":"c1","name":"Cliente Ficticio \\"Ñ\\" 😀","tenantId":"t1","balance":1234567890123.456}'],
  ['Customer', '{"id":"c2","name":"Outro","tenantId":"t1","balance":0.10}'],
  ['Product', '{"id":"p1","price":9.90,"createdAt":"2026-11-19T01:02:03.456"}'],
] as const;
const headerFor = (identity: { backupId: string; tenantId: string; sessionId: string }): BackupHeader => ({ type: 'header', format: 'rm-migration-backup', version: 1, ...identity, createdAt: new Date().toISOString(), engineVersion: 'test', database: { name: 'db', host: 'localhost', fingerprint: 'abc' }, tables });
async function sandbox(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'rmbk-unit-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function write(path: string, encryption: Buffer | null, identity = { backupId: randomUUID(), tenantId: 't1', sessionId: 's1' }) {
  const result = await writeBackupFile(path, encryption, headerFor(identity), async writer => { for (const [table, text] of rows) await writer.row(table, text); });
  return { ...result, identity };
}
const code = (promise: Promise<unknown>) => promise.then(() => 'no error', error => error instanceof BackupFileError ? error.code : `other:${(error as Error).message}`);

for (const sealed of [false, true]) {
  test(`backup file (${sealed ? 'encrypted' : 'plain'}): round trip is byte exact, verified and hides the content when sealed`, async t => {
    const path = join(await sandbox(t), 'a.rmbk'); const encryption = sealed ? key : null;
    const written = await write(path, encryption);
    const verified = await verifyBackupFile(path, encryption, { sha256: written.sha256, size: written.size }, written.identity);
    assert.equal(verified.footer.totalRows, 3); assert.equal(verified.footer.tables.Customer.count, 2); assert.equal(verified.footer.tables.Product.count, 1);
    const restored: string[] = []; const reader = readBackupRows(path, encryption, written.identity);
    for (;;) { const next = await reader.next(); if (next.done) break; restored.push(`${next.value.table}|${next.value.text}`); }
    assert.deepEqual(restored, rows.map(([table, text]) => `${table}|${text}`), 'row payloads are returned exactly as written (no number/date re-serialisation)');
    const raw = readFileSync(path);
    assert.equal(raw.subarray(0, 5).toString(), sealed ? 'RMBK1' : 'RMBK0');
    assert.equal(raw.includes('Cliente Ficticio'), false, 'personal data is never stored as readable text');
  });
}

test('backup file: nonexistent file is reported as missing', async t => {
  const dir = await sandbox(t);
  assert.equal(await code(verifyBackupFile(join(dir, 'nope.rmbk'), null, { sha256: 'x' }, { backupId: 'b', tenantId: 't1', sessionId: 's1' })), 'MISSING');
});

test('backup file: any altered byte, truncation or appended data is detected (hash and authenticated encryption)', async t => {
  const dir = await sandbox(t);
  for (const encryption of [null, key]) {
    const path = join(dir, `c-${encryption ? 's' : 'p'}.rmbk`); const written = await write(path, encryption);
    const recorded = { sha256: written.sha256, size: written.size };
    const original = readFileSync(path);
    const flipped = Buffer.from(original); flipped[Math.floor(original.length / 2)] ^= 0xff; writeFileSync(path, flipped);
    assert.equal(await code(verifyBackupFile(path, encryption, recorded, written.identity)), 'CORRUPT', 'flipped byte');
    // Even when the recorded hash is "updated" to match a tampered file, the content checks (gzip / GCM tag / footer digests) still refuse it.
    const forged = { sha256: createHash('sha256').update(flipped).digest('hex'), size: flipped.length };
    assert.equal(await code(verifyBackupFile(path, encryption, forged, written.identity)), 'CORRUPT', 'tampered file with forged hash');
    writeFileSync(path, original); await truncate(path, Math.floor(original.length * 0.6));
    assert.notEqual(await code(verifyBackupFile(path, encryption, recorded, written.identity)), 'no error', 'truncated');
    writeFileSync(path, original);
    assert.equal(await code(verifyBackupFile(path, encryption, recorded, written.identity)), 'no error', 'restored original is valid again');
  }
});

test('backup file: a stream cut cleanly after complete rows (missing footer) is "incomplete"; garbage is rejected', async t => {
  const dir = await sandbox(t); const path = join(dir, 'd.rmbk');
  const identity = { backupId: 'b1', tenantId: 't1', sessionId: 's1' };
  const header = headerFor(identity);
  const body = `${JSON.stringify(header)}\n{"t":"Customer","r":{"id":"c1"}}\n`;
  await writeFile(path, Buffer.concat([Buffer.from('RMBK0'), gzipSync(body)]));
  const bytes = readFileSync(path);
  assert.equal(await code(verifyBackupFile(path, null, { sha256: createHash('sha256').update(bytes).digest('hex') }, identity)), 'INCOMPLETE');
  await writeFile(path, Buffer.from('not a backup at all'));
  assert.equal(await code(verifyBackupFile(path, null, { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }, identity)), 'CORRUPT');
});

test('backup file: a file of another restaurant, session or backup is refused even when intact', async t => {
  const path = join(await sandbox(t), 'e.rmbk'); const written = await write(path, key);
  const recorded = { sha256: written.sha256, size: written.size };
  for (const other of [{ ...written.identity, tenantId: 'tenant-b' }, { ...written.identity, sessionId: 's2' }, { ...written.identity, backupId: randomUUID() }]) assert.equal(await code(verifyBackupFile(path, key, recorded, other)), 'IDENTITY');
});

test('backup file: wrong or missing key cannot open a sealed backup; writing to unusable storage fails cleanly', async t => {
  const dir = await sandbox(t); const path = join(dir, 'f.rmbk'); const written = await write(path, key);
  const recorded = { sha256: written.sha256, size: written.size };
  assert.equal(await code(verifyBackupFile(path, randomBytes(32), recorded, written.identity)), 'CORRUPT', 'wrong key fails GCM authentication');
  assert.equal(await code(verifyBackupFile(path, null, recorded, written.identity)), 'KEY');
  const blocker = join(dir, 'blocker'); await writeFile(blocker, 'a regular file where a directory is needed');
  assert.equal(await code(write(join(blocker, 'sub', 'g.rmbk'), key)), 'STORAGE');
  assert.throws(() => parseEncryptionKey('too-short'), BackupFileError);
  assert.equal(parseEncryptionKey(undefined), null);
});

test('backup file: tables outside the declared scope cannot be written', async t => {
  const path = join(await sandbox(t), 'h.rmbk');
  assert.equal(await code(writeBackupFile(path, null, headerFor({ backupId: 'b', tenantId: 't1', sessionId: 's1' }), async writer => writer.row('User', '{"id":"u"}'))), 'CORRUPT');
});

test('backup scope covers every table the migration executor writes (guards new import targets)', () => {
  const source = readFileSync(join(__dirname, 'executor.ts'), 'utf8');
  const written = new Set([...source.matchAll(/\btx\.(\w+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map(match => match[1]));
  written.delete('migrationRecord');
  const covered = new Set(BACKUP_MODELS.map(model => model.charAt(0).toLowerCase() + model.slice(1)));
  for (const delegate of written) assert.ok(covered.has(delegate), `executor writes ${delegate} but it is not part of the backup scope`);
  assert.deepEqual(BACKUP_MODELS.map(tableOf), [...BACKUP_MODELS]);
});
