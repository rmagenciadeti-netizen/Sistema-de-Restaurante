import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildEscPos, toPrinterText } from './escpos.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listWindowsPrinters, pollOnce, printJob, sendToNetworkPrinter, sendToWindowsPrinter, syncPrinters } from './client.js';

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
    nextJobs: async () => ({ items: [{ id: 'ok', claimId: 'a', attempts: 1, content: 'a', printer: {} }, { id: 'bad', claimId: 'b', attempts: 2, content: 'b', printer: {} }] }),
    report: async (id, claimId, attempt, ok, error) => reports.push({ id, claimId, attempt, ok, error }),
  };
  const quiet = { info() {}, error() {} };
  const handled = await pollOnce(client, async job => { if (job.id === 'bad') throw new Error('offline'); }, quiet);
  assert.equal(handled, 2);
  assert.deepEqual(reports, [{ id: 'ok', claimId: 'a', attempt: 1, ok: true, error: undefined }, { id: 'bad', claimId: 'b', attempt: 2, ok: false, error: 'offline' }]);
  await assert.rejects(sendToNetworkPrinter({ address: '127.0.0.1', port: 1 }, Buffer.from('x'), 500));
});

test('a failed success confirmation is not reported as a printer failure', async () => {
  const reports = [];
  const client = {
    nextJobs: async limit => { assert.equal(limit, 1); return { items: [{ id: 'printed', claimId: 'a', attempts: 1 }] }; },
    report: async (id, claimId, attempt, ok) => { reports.push({ id, claimId, attempt, ok }); throw new Error('network unavailable'); },
  };
  await assert.rejects(pollOnce(client, async () => {}, { info() {}, error() {} }), /network unavailable/);
  assert.deepEqual(reports, [{ id: 'printed', claimId: 'a', attempt: 1, ok: true }]);
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

test('Windows printers are listed through PowerShell and ignored on other systems', async () => {
  assert.deepEqual(await listWindowsPrinters(async () => { throw new Error('not called'); }, 'linux'), []);
  const calls = [];
  const one = await listWindowsPrinters(async (file, args) => { calls.push({ file, args }); return JSON.stringify({ name: 'EPSON TM-T20', driver: 'EPSON TM-T20 Receipt', port: 'USB001', status: 'Normal', isDefault: true }); }, 'win32');
  assert.deepEqual(one, [{ name: 'EPSON TM-T20', driver: 'EPSON TM-T20 Receipt', port: 'USB001', status: 'Normal', isDefault: true }]);
  assert.equal(calls[0].file, 'powershell.exe');
  const many = await listWindowsPrinters(async () => JSON.stringify([{ name: 'A', isDefault: false }, { name: 'B', isDefault: false }, { isDefault: false }]), 'win32');
  assert.deepEqual(many.map(item => item.name), ['A', 'B']);
  assert.deepEqual(await listWindowsPrinters(async () => '', 'win32'), []);
});

test('Windows jobs go to the named print queue as raw ESC/POS bytes', async () => {
  const sent = [];
  await printJob({ content: 'Via Windows', printer: { connectionType: 'WINDOWS', address: 'EPSON TM-T20', autoCut: true, cashDrawer: false } }, { sendToWindowsPrinter: async (name, data) => sent.push({ name, data }) });
  assert.equal(sent[0].name, 'EPSON TM-T20');
  assert.match(sent[0].data.toString('latin1'), /Via Windows/);
  assert.deepEqual([...sent[0].data.subarray(0, 2)], [0x1b, 0x40]);

  const runs = [];
  await sendToWindowsPrinter('Cozinha "A"', Buffer.from('x'), async (file, args) => { runs.push({ file, args }); });
  assert.equal(runs[0].file, 'powershell.exe');
  assert.equal(runs[0].args[runs[0].args.indexOf('-PrinterName') + 1], 'Cozinha "A"', 'the name travels as an argument, never through a shell string');
  assert.match(runs[0].args.find(arg => arg.endsWith('raw-print.ps1')), /raw-print\.ps1$/);
});

test('the printer list is reported to the API and list errors do not stop the agent', async () => {
  const reported = [];
  const client = { reportPrinters: async printers => reported.push(printers) };
  const quiet = { info() {}, error() {} };
  assert.equal(await syncPrinters(client, async () => [{ name: 'A', isDefault: false }], quiet), 1);
  assert.deepEqual(reported, [[{ name: 'A', isDefault: false }]]);
  assert.equal(await syncPrinters(client, async () => { throw new Error('powershell missing'); }, quiet), 0);
});
