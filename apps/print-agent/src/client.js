import fs from 'node:fs/promises';
import net from 'node:net';
import { buildEscPos } from './escpos.js';

export function sendToNetworkPrinter({ address, port = 9100 }, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address, port });
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(new Error('Printer connection timed out')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(data, () => resolve()));
  });
}

// USB, serial and shared printers are written as raw bytes to the OS device/share path stored in `address`
// (Windows: \\HOST\PRINTER share, COM3 or \\.\USB001 port; Linux: /dev/usb/lp0 or /dev/ttyUSB0).
export async function sendToDevicePath(path, data) {
  const handle = await fs.open(path, 'w');
  try { await handle.write(data); } finally { await handle.close(); }
}

export async function printJob(job) {
  const { printer } = job;
  if (!printer.address) throw new Error('Printer has no address');
  const data = buildEscPos({ content: job.content, autoCut: printer.autoCut, cashDrawer: printer.cashDrawer });
  if (printer.connectionType === 'NETWORK') return sendToNetworkPrinter({ address: printer.address, port: printer.port ?? 9100 }, data);
  if (['USB', 'SHARED', 'SERIAL'].includes(printer.connectionType)) return sendToDevicePath(printer.address, data);
  throw new Error(`Unsupported connection type: ${printer.connectionType}`);
}

export class ApiClient {
  constructor(baseUrl, token, fetchImpl = fetch) { this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl; }
  async request(method, path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`API ${method} ${path} failed with ${response.status}`);
    return response.json();
  }
  nextJobs(limit = 5) { return this.request('GET', `/print-agent/jobs/next?limit=${limit}`); }
  report(id, claimId, attempt, ok, error) { return this.request('POST', `/print-agent/jobs/${id}/result`, { claimId, attempt, ok, ...(error ? { error: error.slice(0, 500) } : {}) }); }
}

export async function pollOnce(client, print = printJob, log = console) {
  const { items } = await client.nextJobs(1);
  for (const job of items) {
    try {
      await print(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`failed ${job.id}: ${message}`);
      await client.report(job.id, job.claimId, job.attempts, false, message);
      continue;
    }
    await client.report(job.id, job.claimId, job.attempts, true);
    log.info(`printed ${job.id}`);
  }
  return items.length;
}

export async function run({ apiUrl, token, intervalMs = 3000, signal }) {
  const client = new ApiClient(apiUrl, token);
  while (!signal?.aborted) {
    let busy = 0;
    try { busy = await pollOnce(client); } catch (error) { console.error(`poll error: ${error.message}`); }
    // Back off only when idle so bursts of jobs are drained quickly.
    if (!busy) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
