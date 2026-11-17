import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { serializable } from './serializable';

test('retries serialization conflicts, but not other errors, with a bounded limit', async () => {
  const conflict = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
  let attempts = 0;
  const client = { $transaction: async (operation: () => Promise<string>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (++attempts < 3) throw conflict;
    return operation();
  } } as unknown as PrismaClient;
  assert.equal(await serializable(client, async () => 'ok'), 'ok');
  assert.equal(attempts, 3);
  attempts = 0;
  const alwaysConflict = { $transaction: async () => { attempts++; throw conflict; } } as unknown as PrismaClient;
  await assert.rejects(serializable(alwaysConflict, async () => 'unused'), error => error === conflict);
  assert.equal(attempts, 3);
  const failure = new Error('audit failed');
  const failed = { $transaction: async () => { throw failure; } } as unknown as PrismaClient;
  await assert.rejects(serializable(failed, async () => 'unused'), error => error === failure);
});
