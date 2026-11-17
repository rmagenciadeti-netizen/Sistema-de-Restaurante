import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildEscPos, toPrinterText } from './escpos.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pollOnce, printJob, sendToNetworkPrinter } from './client.js';

test('text is folded to printable ASCII', () => {
  assert.equal(toPrinterText('Pão de açúcar — 2x'), 'Pao de acucar ? 2x');
});

test('ESC/POS output initialises, prints, cuts and optionally opens the drawer', () => {
  const data = buildEscPos({ content: 'OK', autoCut: true, cashDrawer: true });
  assert.deepEqual([...data.subarray(0, 2)], [0x1b, 0x40]);
  assert.ok(data.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])));
  assert.ok(data.includes(Buffer.from([0x1b, 0x70])));
  assert.ok(!buildEscPos({ content: 'OK', autoCut: false }).includes(Buffer.from([0x1d, 0x56])));
});

test('jobs are delivered over TCP to the configured printer', async () => {
  const received = [];
  const server = net.createServer(socket => socket.on('data', chunk => received.push(chunk)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await printJob({ content: 'Pedido 1', printer: { connectionType: 'NETWORK', address: '127.0.0.1', port, autoCut: true, cashDrawer: false } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(Buffer.concat(received).toString('latin1'), /Pedido 1/);
    await assert.rejects(printJob({ content: 'x', printer: { connectionType: 'USB', address: null } }), /no address/);
    await assert.rejects(printJob({ content: 'x', printer: { connectionType: 'BLUETOOTH', address: 'x' } }), /Unsupported connection type/);
  } finally { server.close(); }
});

test('connection failures are reported back to the API instead of crashing the loop', async () => {
  const reports = [];
  const client = {
    nextJobs: async () => ({ items: [{ id: 'ok', content: 'a', printer: {} }, { id: 'bad', content: 'b', printer: {} }] }),
    report: async (id, ok, error) => reports.push({ id, ok, error }),
  };
  const quiet = { info() {}, error() {} };
  const handled = await pollOnce(client, async job => { if (job.id === 'bad') throw new Error('offline'); }, quiet);
  assert.equal(handled, 2);
  assert.deepEqual(reports, [{ id: 'ok', ok: true, error: undefined }, { id: 'bad', ok: false, error: 'offline' }]);
  await assert.rejects(sendToNetworkPrinter({ address: '127.0.0.1', port: 1 }, Buffer.from('x'), 500));
});

test('USB, shared and serial printers receive raw bytes on the device path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-'));
  try {
    for (const connectionType of ['USB', 'SHARED', 'SERIAL']) {
      const target = path.join(dir, connectionType);
      await printJob({ content: `Via ${connectionType}`, printer: { connectionType, address: target, autoCut: true, cashDrawer: false } });
      const written = await fs.readFile(target);
      assert.match(written.toString('latin1'), new RegExp(`Via ${connectionType}`));
      assert.deepEqual([...written.subarray(0, 2)], [0x1b, 0x40]);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
