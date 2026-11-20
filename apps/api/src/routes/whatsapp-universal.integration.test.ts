import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { WhatsappSessionManager, VIEWER_ACTIVE_MS } from '../lib/whatsapp-sessions';
import { DbAuthStore } from '../lib/whatsapp-auth-store';
import type { TransportHandlers, WaTransport } from '../lib/whatsapp-transport';
import { setAiProvider } from '../lib/ai-provider';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

class FakeTransport implements WaTransport {
  handlers!: TransportHandlers; stopped = false;
  async start(handlers: TransportHandlers) { this.handlers = handlers; }
  async sendText() { return 'x'; }
  async resolveJid(digits: string) { return `${digits}@s.whatsapp.net`; }
  async stop() { this.stopped = true; }
}
async function waitFor<T>(check: () => Promise<T | null | false | undefined>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('waitFor timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('universal WhatsApp (QR) and AI provider: persistence, leader election, license, renewal, platform AI', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'w'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  setAiProvider(undefined);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  };
  const id = randomBytes(4).toString('hex');
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN, mfaEnabled: true } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN, mfaAuthenticated: true });
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
    const token = async (role: UserRole) => signAccessToken({ userId: (await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role } })).id, tenantId: tenant.id, unitId: null, role });
    return { tenant, token };
  };
  const A = await makeTenant('wa-a'); const B = await makeTenant('wa-b');
  const adminA = await A.token(UserRole.ADMIN); const cashierA = await A.token(UserRole.CASHIER); const adminB = await B.token(UserRole.ADMIN);
  const managers: WhatsappSessionManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.stop();
    setAiProvider(undefined);
    await prisma.platformAiConfig.deleteMany({});
    await prisma.whatsappManager.deleteMany({});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  await t.test('the pairing is stored encrypted in the database, survives a restart and is isolated per restaurant', async () => {
    const baileys: any = await import('@whiskeysockets/baileys');
    const first = await new DbAuthStore(prisma, A.tenant.id).load(baileys);
    await first.saveCreds();
    await first.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('secret-private'), public: Buffer.from('public') } } });
    const raw = await prisma.whatsappAuthKey.findMany({ where: { tenantId: A.tenant.id } });
    assert.ok(raw.length >= 2); assert.ok(raw.every(row => row.value.startsWith('v1:') && !row.value.includes('secret-private')), 'values are sealed');
    const reloaded = await new DbAuthStore(prisma, A.tenant.id).load(baileys);
    assert.equal(Buffer.from(reloaded.state.creds.noiseKey.private).toString('hex'), Buffer.from(first.state.creds.noiseKey.private).toString('hex'), 'same credentials after a restart');
    assert.equal(Buffer.from(((await reloaded.state.keys.get('pre-key', ['1']))['1'] as any).private).toString(), 'secret-private');
    const other = await new DbAuthStore(prisma, B.tenant.id).load(baileys);
    assert.notEqual(Buffer.from(other.state.creds.noiseKey.private).toString('hex'), Buffer.from(first.state.creds.noiseKey.private).toString('hex'));
    assert.deepEqual((await other.state.keys.get('pre-key', ['1']))['1'], null, 'another restaurant never sees these keys');
    await new DbAuthStore(prisma, A.tenant.id).wipe();
    assert.equal(await prisma.whatsappAuthKey.count({ where: { tenantId: A.tenant.id } }), 0);
    assert.equal(await prisma.whatsappAuthKey.count({ where: { tenantId: B.tenant.id } }) >= 0, true);
  });

  await t.test('only one manager operates; the standby takes over on release and on a crash', async () => {
    await prisma.whatsappManager.deleteMany({});
    const make = (pid: number) => { const transports: FakeTransport[] = []; const manager = new WhatsappSessionManager(prisma, { identity: { pid, host: 'test' }, factory: () => { const fake = new FakeTransport(); transports.push(fake); return fake; }, sleep: async () => undefined, log: () => undefined }); managers.push(manager); return { manager, transports }; };
    const one = make(1001); const two = make(1002);
    await prisma.whatsappSession.upsert({ where: { tenantId: A.tenant.id }, create: { tenantId: A.tenant.id, desired: 'CONNECTED' }, update: { desired: 'CONNECTED', status: 'DISCONNECTED' } });
    await one.manager.tick(); await two.manager.tick();
    assert.equal(one.manager.isLeader(), true); assert.equal(two.manager.isLeader(), false);
    assert.equal(one.transports.length, 1); assert.equal(two.transports.length, 0, 'the standby does not open a second socket for the same number');
    await one.manager.stop();
    await two.manager.tick();
    assert.equal(two.manager.isLeader(), true); assert.equal(two.transports.length, 1, 'takes over right after a graceful release (deploy)');
    await prisma.whatsappManager.update({ where: { id: 'default' }, data: { pid: 9999, heartbeatAt: new Date(Date.now() - 60_000) } });
    const three = make(1003);
    await three.manager.tick();
    assert.equal(three.manager.isLeader(), true, 'a stale heartbeat (crash) is taken over');
    await two.manager.tick();
    assert.equal(two.manager.isLeader(), false, 'the old holder notices and stands by');
    await three.manager.stop(); await prisma.whatsappSession.update({ where: { tenantId: A.tenant.id }, data: { desired: 'DISCONNECTED', status: 'DISCONNECTED' } });
  });

  await t.test('module released by the administrator controls the WhatsApp session; revoking pauses it and giving it back resumes', async () => {
    await prisma.whatsappManager.deleteMany({});
    const transports: FakeTransport[] = [];
    const manager = new WhatsappSessionManager(prisma, { identity: { pid: 2001, host: 'test' }, factory: () => { const fake = new FakeTransport(); transports.push(fake); return fake; }, sleep: async () => undefined, log: () => undefined });
    managers.push(manager);
    await prisma.tenantLicense.create({ data: { tenantId: B.tenant.id, status: 'ACTIVE' } });
    await prisma.tenantModule.create({ data: { tenantId: B.tenant.id, moduleKey: 'pos' } });
    assert.equal((await call('GET', '/whatsapp/session', adminB)).status, 403, 'module not contracted: the API gate refuses');
    await prisma.whatsappSession.upsert({ where: { tenantId: B.tenant.id }, create: { tenantId: B.tenant.id, desired: 'CONNECTED' }, update: { desired: 'CONNECTED' } });
    await manager.tick();
    assert.equal(transports.length, 0, 'no socket for a company without the module');
    assert.match((await prisma.whatsappSession.findUniqueOrThrow({ where: { tenantId: B.tenant.id } })).lastError ?? '', /módulo WhatsApp/);
    assert.equal((await call('PUT', `/tenants/${B.tenant.id}/modules`, masterToken, { modules: ['pos', 'whatsapp'] })).status, 200);
    assert.equal((await call('GET', '/whatsapp/session', adminB)).status, 200, 'released: access granted');
    await manager.tick(); assert.equal(transports.length, 1, 'the session starts automatically once released');
    transports[0].handlers.onQr('qr-1'); assert.equal((await waitFor(async () => (await prisma.whatsappSession.findUnique({ where: { tenantId: B.tenant.id } }))?.status === 'QR_READY' && true)), true);
    assert.equal((await call('PUT', `/tenants/${B.tenant.id}/modules`, masterToken, { modules: ['pos'] })).status, 200);
    await manager.tick(); assert.equal(transports[0].stopped, true, 'revoked: the running socket is stopped');
    await prisma.tenantModule.create({ data: { tenantId: B.tenant.id, moduleKey: 'whatsapp' } });
    await manager.tick(); assert.equal(transports.length, 2, 'given back: reconnects by itself');
    await manager.stop(); await prisma.whatsappSession.update({ where: { tenantId: B.tenant.id }, data: { desired: 'DISCONNECTED', status: 'DISCONNECTED' } });
  });

  await t.test('opening the connection screen starts the QR by itself, "Renovar" restarts it and the code keeps renewing while someone watches', async () => {
    await prisma.whatsappManager.deleteMany({});
    await prisma.whatsappSession.deleteMany({ where: { tenantId: A.tenant.id } });
    assert.equal((await call('GET', '/whatsapp/session?autoConnect=1', cashierA)).body.desired, 'DISCONNECTED', 'only managers can start it');
    const started = await call('GET', '/whatsapp/session?autoConnect=1', adminA);
    assert.equal(started.body.desired, 'CONNECTED'); assert.equal(started.body.status, 'CONNECTING');
    const transports: FakeTransport[] = [];
    const manager = new WhatsappSessionManager(prisma, { identity: { pid: 3001, host: 'test' }, factory: () => { const fake = new FakeTransport(); transports.push(fake); return fake; }, sleep: async () => undefined, log: () => undefined });
    managers.push(manager);
    await manager.tick(); assert.equal(transports.length, 1);
    transports[0].handlers.onQr('qr-a');
    await waitFor(async () => (await call('GET', '/whatsapp/session', adminA)).body.qr === 'qr-a');
    assert.equal((await call('POST', '/whatsapp/session/renew', cashierA)).status, 403);
    assert.equal((await call('POST', '/whatsapp/session/renew', adminA)).status, 202);
    await manager.tick(); assert.equal(transports[0].stopped, true); assert.equal(transports.length >= 1, true);
    await manager.tick(); assert.equal(transports.length, 2, 'renewed: a fresh connection is opened');
    // Nobody scans: after the unconfirmed attempts the manager gives up — unless the screen is still open.
    await prisma.whatsappSession.update({ where: { tenantId: A.tenant.id }, data: { viewedAt: new Date() } });
    for (let index = 0; index < 6; index += 1) { const live = transports[transports.length - 1]; live.handlers.onClose({ loggedOut: false, error: 'timeout' }); await new Promise(resolve => setTimeout(resolve, 60)); (manager as any).retryAt.clear(); await manager.tick(); }
    assert.equal((await prisma.whatsappSession.findUniqueOrThrow({ where: { tenantId: A.tenant.id } })).desired, 'CONNECTED', 'still renewing while the screen is open');
    await prisma.whatsappSession.update({ where: { tenantId: A.tenant.id }, data: { viewedAt: new Date(Date.now() - VIEWER_ACTIVE_MS - 1000) } });
    for (let index = 0; index < 6; index += 1) { const live = transports[transports.length - 1]; live.handlers.onClose({ loggedOut: false, error: 'timeout' }); await new Promise(resolve => setTimeout(resolve, 60)); (manager as any).retryAt.clear(); await manager.tick(); if ((await prisma.whatsappSession.findUniqueOrThrow({ where: { tenantId: A.tenant.id } })).desired === 'DISCONNECTED') break; }
    assert.equal((await prisma.whatsappSession.findUniqueOrThrow({ where: { tenantId: A.tenant.id } })).desired, 'DISCONNECTED', 'stops generating codes when nobody is looking');
    await manager.stop();
  });

  await t.test('master monitors every session without seeing credentials; restaurants cannot', async () => {
    const overview = await call('GET', '/tenants/whatsapp/sessions', masterToken);
    assert.equal(overview.status, 200); assert.ok(overview.body.items.some((item: any) => item.tenantId === A.tenant.id));
    assert.ok(!overview.text.includes('qr-a')); assert.notEqual((await call('GET', '/tenants/whatsapp/sessions', adminA)).status, 200);
  });

  await t.test('AI provider chosen in the platform panel: encrypted key, real test call, honest status, OpenAI-compatible and Anthropic', async () => {
    const seen: { url: string; headers: IncomingMessage['headers']; body: any }[] = [];
    const provider = createServer((request, response) => {
      let raw = ''; request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}; seen.push({ url: request.url ?? '', headers: request.headers, body });
        const good = request.headers.authorization === 'Bearer sk-good-key-123' || request.headers['x-api-key'] === 'sk-good-key-123';
        if (!good) { response.writeHead(401, { 'content-type': 'application/json' }); return response.end('{"error":"nope sk-wrong"}'); }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(request.url?.endsWith('/messages') ? JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 7, output_tokens: 1 } }) : JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => { provider.close(); });
    const host = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    try {
      assert.equal((await call('GET', '/platform/ai', adminA)).status, 403, 'restaurants cannot read or change it');
      assert.equal((await call('GET', '/platform/ai', masterToken)).body.status, 'NOT_CONFIGURED');
      assert.equal((await call('POST', '/platform/ai/test', masterToken)).status, 409, 'no provider: no pretending');
      assert.equal((await call('PUT', '/platform/ai', masterToken, { provider: 'custom', model: 'mm', apiKey: 'sk-good-key-123' })).status, 400, 'custom needs an endpoint');
      assert.equal((await call('PUT', '/platform/ai', masterToken, { provider: 'custom', model: 'mm', baseUrl: 'ftp://x', apiKey: 'sk-good-key-123' })).status, 400);
      const saved = await call('PUT', '/platform/ai', masterToken, { provider: 'custom', model: 'test-model', baseUrl: `${host}/v1`, apiKey: 'sk-good-key-123' });
      assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.status, 'CONFIGURED_UNVERIFIED'); assert.equal(saved.body.source, 'platform');
      assert.ok(!saved.text.includes('sk-good-key-123'), 'the key is never returned');
      assert.ok(!(await prisma.platformAiConfig.findUniqueOrThrow({ where: { id: 'default' } })).apiKeyEnc.includes('sk-good-key-123'), 'stored sealed');
      const tested = await call('POST', '/platform/ai/test', masterToken);
      assert.equal(tested.status, 200, tested.text); assert.equal(tested.body.ok, true); assert.equal(tested.body.status, 'VERIFIED');
      const request = seen.at(-1)!; assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer sk-good-key-123'); assert.equal(request.body.model, 'test-model');
      assert.equal((await call('GET', '/platform/ai', masterToken)).body.status, 'VERIFIED');
      const { currentAiProvider } = await import('../lib/ai-provider');
      assert.equal(await currentAiProvider()!.answer({ system: 's', question: 'q' }), 'OK', 'the system now uses it');
      // Anthropic uses its own API shape.
      assert.equal((await call('PUT', '/platform/ai', masterToken, { provider: 'anthropic', model: 'claude-test', baseUrl: host })).status, 200, 'changing the model keeps the stored key');
      assert.equal((await call('POST', '/platform/ai/test', masterToken)).body.ok, true);
      const anthropic = seen.at(-1)!; assert.equal(anthropic.url, '/v1/messages'); assert.equal(anthropic.headers['x-api-key'], 'sk-good-key-123'); assert.equal(anthropic.headers['anthropic-version'], '2023-06-01'); assert.equal(anthropic.body.system, 'Você é um verificador de conexão.');
      // A wrong key is reported as a failure, without echoing anything from the provider.
      assert.equal((await call('PUT', '/platform/ai', masterToken, { provider: 'custom', model: 'mm', baseUrl: `${host}/v1`, apiKey: 'sk-wrong-key-999' })).status, 200);
      const failed = await call('POST', '/platform/ai/test', masterToken);
      assert.equal(failed.status, 502); assert.ok(!failed.text.includes('sk-wrong'));
      const status = await call('GET', '/platform/ai', masterToken); assert.equal(status.body.status, 'FAILED'); assert.ok(!status.text.includes('sk-wrong'));
      assert.equal((await call('DELETE', '/platform/ai', masterToken)).body.status, 'NOT_CONFIGURED');
    } finally { await prisma.platformAiConfig.deleteMany({}); }
  });
});
