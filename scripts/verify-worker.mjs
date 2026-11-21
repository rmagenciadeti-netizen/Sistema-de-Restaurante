#!/usr/bin/env node
// Proves the production worker is really processing (not just "Live" on the host). Reads GET /api/v1/health/worker twice and requires:
// status "up", a fresh heartbeat, every enabled task "ok", progress between the two reads (cycles of the scheduling task grow) and the same start time (no restarts).
// Usage: node scripts/verify-worker.mjs [apiBaseUrl] [--commit <sha>] [--wait <seconds>]
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const commit = option('--commit');
const wait = Number(option('--wait') ?? 25);
const base = (args[0] ?? 'https://rm-restaurant-api.onrender.com').replace(/\/$/, '');
const url = `${base}/api/v1/health/worker`;

const fail = message => { console.error(`FAIL: ${message}`); process.exit(1); };
const read = async () => {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!body) fail(`${url} did not return JSON (HTTP ${response.status}); is the API on the version that has this endpoint?`);
  return { http: response.status, body };
};

const first = await read();
console.log(`#1 HTTP ${first.http} status=${first.body.status} reason=${first.body.reason ?? '-'} heartbeatAge=${first.body.heartbeatAgeSeconds}s uptime=${first.body.uptimeSeconds}s commit=${first.body.commit ?? '-'}`);
if (first.http !== 200 || first.body.status !== 'up') fail(`worker is "${first.body.status}" (${first.body.reason ?? 'no reason'})`);
if (commit && !String(first.body.commit ?? '').startsWith(commit.slice(0, 7))) fail(`worker runs commit ${first.body.commit}, expected ${commit.slice(0, 7)}`);

await new Promise(resolve => setTimeout(resolve, wait * 1000));
const second = await read();
console.log(`#2 HTTP ${second.http} status=${second.body.status} heartbeatAge=${second.body.heartbeatAgeSeconds}s uptime=${second.body.uptimeSeconds}s`);
if (second.http !== 200 || second.body.status !== 'up') fail(`worker is "${second.body.status}" on the second read`);
if (second.body.startedAt !== first.body.startedAt) fail('the worker restarted between the two reads');
if (second.body.heartbeatAgeSeconds > 30) fail(`heartbeat is ${second.body.heartbeatAgeSeconds}s old`);

const tasks = second.body.tasks ?? {};
for (const [name, task] of Object.entries(tasks)) {
  console.log(`   ${name.padEnd(11)} ${task.status.padEnd(8)} runs=${task.runs} processed=${task.processed} failures=${task.failures}`);
  if (!['ok', 'disabled'].includes(task.status)) fail(`task "${name}" is ${task.status}`);
}
const progressed = (second.body.tasks?.scheduling?.runs ?? 0) - (first.body.tasks?.scheduling?.runs ?? 0);
if (progressed < 1) fail(`the scheduling task did not run during ${wait}s: the worker is alive but not processing`);
console.log(`OK: the worker is up, stable since ${second.body.startedAt}, and ran the scheduling task ${progressed} time(s) in ${wait}s.`);
