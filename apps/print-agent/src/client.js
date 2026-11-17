import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEscPos } from './escpos.js';

const rawPrintScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'raw-print.ps1');
const runCommand = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 20000, ...options }, (error, stdout, stderr) => (error ? reject(new Error((stderr || stdout || error.message).toString().trim().slice(0, 300))) : resolve(stdout.toString()))));

// Printers installed in Windows (all queues: USB, network, shared, virtual). Empty on other systems.
export async function listWindowsPrinters(exec = runCommand, platform = process.platform) {
  if (platform !== 'win32') return [];
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d=(Get-CimInstance Win32_Printer | Where-Object Default).Name; @(Get-Printer | ForEach-Object { [pscustomobject]@{ name=$_.Name; driver=$_.DriverName; port=$_.PortName; status=[string]$_.PrinterStatus; isDefault=($_.Name -eq $d) } }) | ConvertTo-Json -Compress";
  const out = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => item?.name).map(item => ({ name: String(item.name), driver: item.driver ? String(item.driver) : undefined, port: item.port ? String(item.port) : undefined, status: item.status ? String(item.status) : undefined, isDefault: Boolean(item.isDefault) }));
}

// Writes the ESC/POS bytes straight into the Windows print queue (RAW), so the printer driver does not reformat them.
export async function sendToWindowsPrinter(name, data, exec = runCommand) {
  const file = path.join(os.tmpdir(), `rm-print-${process.pid}-${Date.now()}.bin`);
  await fs.writeFile(file, data);
  try { await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', rawPrintScript, '-PrinterName', name, '-Path', file]); }
  finally { await fs.rm(file, { force: true }); }
}

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

export async function printJob(job, deps = {}) {
  const { printer } = job;
  if (!printer.address) throw new Error('Printer has no address');
  const data = buildEscPos({ content: job.content, autoCut: printer.autoCut, cashDrawer: printer.cashDrawer });
  if (printer.connectionType === 'WINDOWS') return (deps.sendToWindowsPrinter ?? sendToWindowsPrinter)(printer.address, data);
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
  reportPrinters(printers) { return this.request('POST', '/print-agent/printers', { printers }); }
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

// Keeps the panel's list of Windows printers current; failures never interrupt printing.
export async function syncPrinters(client, list = listWindowsPrinters, log = console) {
  try { const printers = await list(); if (printers.length || process.platform === 'win32') await client.reportPrinters(printers); return printers.length; }
  catch (error) { log.error(`printer list error: ${error.message}`); return 0; }
}

export async function run({ apiUrl, token, intervalMs = 3000, printerSyncMs = 60000, signal }) {
  const client = new ApiClient(apiUrl, token);
  let lastSync = 0;
  while (!signal?.aborted) {
    if (Date.now() - lastSync >= printerSyncMs) { lastSync = Date.now(); await syncPrinters(client); }
    let busy = 0;
    try { busy = await pollOnce(client); } catch (error) { console.error(`poll error: ${error.message}`); }
    // Back off only when idle so bursts of jobs are drained quickly.
    if (!busy) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
