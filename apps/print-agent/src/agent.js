#!/usr/bin/env node
import { run } from './client.js';

const apiUrl = process.env.RM_API_URL;
const token = process.env.RM_AGENT_TOKEN;
if (!apiUrl || !token) {
  console.error('Set RM_API_URL (e.g. https://api.example.com/api/v1) and RM_AGENT_TOKEN (generated in Produção e Impressão > Agentes).');
  process.exit(1);
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
console.log('RM print agent started');
await run({ apiUrl, token, intervalMs: Number(process.env.RM_POLL_INTERVAL_MS) || 3000, signal: controller.signal });
