import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { processWhatsappOutbox } from './whatsapp-worker';

function fakeClient(rows: Array<{ id: string; tenantId: string; toPhone: string; template: string; payload: unknown }>) {
  const updates: Array<{ id: string; data: any }> = [];
  const client = {
    whatsappMessage: {
      findMany: async () => rows,
      update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); },
    },
  } as unknown as PrismaClient;
  return { client, updates };
}

test('outbox is left untouched when no provider is configured', async () => {
  const { client, updates } = fakeClient([{ id: '1', tenantId: 't', toPhone: '5511', template: 'x', payload: null }]);
  assert.deepEqual(await processWhatsappOutbox(client, null), { sent: 0, failed: 0, skipped: true });
  assert.equal(updates.length, 0);
});

test('provider results are persisted per message and failures do not stop the batch', async () => {
  const { client, updates } = fakeClient([
    { id: 'ok', tenantId: 't', toPhone: '5511', template: 'order_ready', payload: {} },
    { id: 'bad', tenantId: 't', toPhone: '5522', template: 'order_ready', payload: {} },
  ]);
  const result = await processWhatsappOutbox(client, { send: async m => { if (m.id === 'bad') throw new Error('rejected'); return { providerRef: 'wamid.1' }; } });
  assert.deepEqual(result, { sent: 1, failed: 1, skipped: false });
  assert.equal(updates[0].data.status, 'SENT'); assert.equal(updates[0].data.providerRef, 'wamid.1');
  assert.equal(updates[1].data.status, 'FAILED'); assert.equal(updates[1].data.error, 'rejected');
});
