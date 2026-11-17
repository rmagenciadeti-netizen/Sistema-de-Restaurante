import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('Windows printers: reported by the agent, chosen in the panel and printed only by their agent', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };
  const suffix = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`, status: 'ACTIVE' } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: label, email: `${label}-${suffix}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
    return { tenant, token: signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role: UserRole.ADMIN }) };
  };
  const A = await makeTenant('winprn'); const B = await makeTenant('winother');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  const caixa = (await call('POST', '/printing/agents', A.token, { name: 'Caixa' })).body;
  const cozinha = (await call('POST', '/printing/agents', A.token, { name: 'Cozinha' })).body;
  const foreign = (await call('POST', '/printing/agents', B.token, { name: 'Outro' })).body;

  const report = (token: string, printers: unknown) => call('POST', '/print-agent/printers', token, { printers });
  assert.equal((await report('rmagt_invalid', [])).status, 401);
  assert.equal((await report(caixa.token, [{ name: '' }])).status, 400);
  assert.equal((await report(caixa.token, [{ name: 'EPSON TM-T20', isDefault: true, driver: 'EPSON', port: 'USB001' }, { name: 'Microsoft Print to PDF' }, { name: 'EPSON TM-T20' }])).body.received, 2, 'duplicated names are merged');
  const listed = (await call('GET', '/printing/agents', A.token)).body.items.find((agent: any) => agent.id === caixa.id);
  assert.deepEqual(listed.printers.map((printer: any) => printer.name), ['EPSON TM-T20', 'Microsoft Print to PDF']);
  assert.ok(listed.printersReportedAt);
  assert.equal((await call('GET', '/printing/agents', B.token)).body.items.some((agent: any) => agent.id === caixa.id), false);

  const sector = (await call('POST', '/production/sectors', A.token, { name: 'Bar', autoPrint: true })).body;
  const create = (body: Record<string, unknown>) => call('POST', '/printing/printers', A.token, { name: 'Impressora', connectionType: 'WINDOWS', ...body });
  assert.equal((await create({ address: 'EPSON TM-T20' })).status, 400, 'a Windows printer needs its agent');
  assert.equal((await create({ agentId: caixa.id })).status, 400, 'a Windows printer needs its name');
  assert.equal((await create({ address: 'EPSON TM-T20', agentId: foreign.id })).status, 400, 'agents of other tenants are refused');
  const windows = await create({ name: 'Bar Epson', address: 'EPSON TM-T20', agentId: caixa.id, sectorId: sector.id, isPrimary: true });
  assert.equal(windows.status, 201, JSON.stringify(windows.body));
  assert.equal(windows.body.agentId, caixa.id);
  const network = await call('POST', '/printing/printers', A.token, { name: 'Rede', connectionType: 'NETWORK', address: '10.0.0.5', agentId: caixa.id });
  assert.equal(network.body.agentId, null, 'only Windows printers are bound to an agent');
  assert.equal((await call('PATCH', `/printing/printers/${windows.body.id}`, A.token, { address: '' })).status, 400);
  assert.equal((await call('PATCH', `/printing/printers/${network.body.id}`, A.token, { connectionType: 'WINDOWS' })).status, 400, 'switching to Windows requires the Windows fields');
  const switched = await call('PATCH', `/printing/printers/${windows.body.id}`, A.token, { connectionType: 'USB', address: '/dev/usb/lp0' });
  assert.equal(switched.body.agentId, null, 'leaving Windows drops the agent');
  await call('PATCH', `/printing/printers/${windows.body.id}`, A.token, { connectionType: 'WINDOWS', address: 'EPSON TM-T20', agentId: caixa.id });

  const test_ = await call('POST', `/printing/printers/${windows.body.id}/test`, A.token);
  assert.equal(test_.status, 201);
  const claim = (token: string) => call('GET', '/print-agent/jobs/next?limit=5', token);
  assert.equal((await claim(cozinha.token)).body.items.length, 0, 'another agent never claims a Windows printer job');
  const mine = (await claim(caixa.token)).body.items;
  assert.equal(mine.length, 1);
  assert.deepEqual({ type: mine[0].printer.connectionType, address: mine[0].printer.address, name: mine[0].printer.name }, { type: 'WINDOWS', address: 'EPSON TM-T20', name: 'Bar Epson' });

  const netJob = await call('POST', `/printing/printers/${network.body.id}/test`, A.token);
  assert.equal(netJob.status, 201);
  assert.equal((await claim(cozinha.token)).body.items.length, 1, 'network jobs stay open to any agent');
});
