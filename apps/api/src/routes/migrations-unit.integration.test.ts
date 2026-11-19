import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget.
const enabled = process.env.RUN_DB_TESTS === '1';

const CSV = {
  'produtos.csv': 'Codigo;Nome;Preco;Estoque\nP1;Prato executivo;40,00;12\n',
  'contas_pagar.csv': 'Descricao;Valor;Vencimento;Pagamento;Valor pago\nAluguel;1500,00;10/02/2024;10/02/2024;1500,00\nEnergia;300,00;15/02/2024;;\n',
  'vendas.csv': 'Numero venda;Data da venda;Total;Forma de pagamento;Situação\n2001;15/03/2024;50,00;Dinheiro;Fechada\n',
  'itens_venda.csv': 'Numero venda;Codigo produto;Produto;Quantidade;Preco unitario\n2001;P1;Prato executivo;1;50,00\n',
};

test('RM Smart Migration: destination unit — unit-bound records land in the chosen unit, other units/companies are untouched and foreign units are refused', { skip: !enabled, timeout: 180_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32); process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64'); process.env.DEV_DISABLE_MFA = 'true'; process.env.RM_RESTAURANT_URL = 'https://restaurant.example'; process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown, raw?: Buffer) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'application/octet-stream' } : {}) }, body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const tenantA = await prisma.tenant.create({ data: { name: `Unit A ${id}`, slug: `unit-a-${id}`, status: 'ACTIVE' } });
  const tenantB = await prisma.tenant.create({ data: { name: `Unit B ${id}`, slug: `unit-b-${id}`, status: 'ACTIVE' } });
  const [matriz, filial] = await Promise.all([prisma.unit.create({ data: { tenantId: tenantA.id, name: 'Matriz' } }), prisma.unit.create({ data: { tenantId: tenantA.id, name: 'Filial' } })]);
  const foreign = await prisma.unit.create({ data: { tenantId: tenantB.id, name: 'Outra empresa' } });
  const master = await prisma.user.create({ data: { name: 'Operador RM', email: `mu-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const token = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  assert.deepEqual(((await call('GET', `/migrations/tenants/${tenantA.id}/units`, token)).body.items as any[]).map(unit => unit.name), ['Filial', 'Matriz'], 'only this restaurant\'s units are offered');
  const refused = await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, token, { label: 'Unidade alheia', sourceUnknown: true, unitId: foreign.id });
  assert.equal(refused.status, 400); assert.equal(await prisma.migrationSession.count({ where: { tenantId: tenantA.id } }), 0);

  const created = await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, token, { label: 'Filial', sourceUnknown: true, unitId: filial.id });
  assert.equal(created.status, 201); assert.equal(created.body.unitId, filial.id);
  const sid = created.body.id as string; const path = (suffix = '') => `/migrations/tenants/${tenantA.id}/sessions/${sid}${suffix}`;
  for (const [name, content] of Object.entries(CSV)) assert.equal((await call('POST', path(`/files?name=${name}`), token, undefined, Buffer.from(content))).status, 201);
  const analysis = await call('POST', path('/analyze'), token, {}); assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  const tables = Object.values(analysis.body.mapping.tables) as any[];
  assert.equal((await call('PUT', path('/mapping'), token, { tables: Object.fromEntries(tables.map(table => [table.key, { approved: true }])) })).status, 200);
  assert.equal((await call('POST', path('/preview'), token, {})).status, 200);
  await call('POST', path('/bulk-approve'), token, {});
  assert.equal((await call('POST', path('/approve'), token, { confirm: 'EXECUTAR' })).status, 200);
  assert.ok([200, 202].includes((await call('POST', path('/execute'), token, {})).status));
  let session: any;
  for (let attempt = 0; attempt < 60; attempt++) { session = (await call('GET', path(''), token)).body; if (['COMPLETED', 'INTERRUPTED'].includes(session.status)) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(session.status, 'COMPLETED', JSON.stringify(session.validation));

  const entries = await prisma.financialEntry.findMany({ where: { tenantId: tenantA.id } });
  assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.unitId === filial.id), 'payables are in the chosen unit');
  const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenantA.id }, include: { payments: true } });
  assert.equal(order.unitId, filial.id); assert.ok(order.payments.every(payment => payment.unitId === filial.id));
  const opening = await prisma.productStockMovement.findFirstOrThrow({ where: { tenantId: tenantA.id } });
  assert.equal(opening.unitId, filial.id); assert.equal(Number(opening.quantity), 12, 'opening balance recorded once, in the chosen unit');
  for (const model of ['financialEntry', 'order', 'productStockMovement'] as const) assert.equal(await (prisma[model] as any).count({ where: { tenantId: tenantA.id, unitId: matriz.id } }), 0, `${model}: the other unit receives nothing`);
  assert.equal(await prisma.financialEntry.count({ where: { tenantId: tenantB.id } }) + await prisma.order.count({ where: { tenantId: tenantB.id } }), 0, 'the other company is untouched');

  // Reverting removes what this migration created, in the same unit, and leaves the other unit's own data alone.
  const own = await prisma.financialEntry.create({ data: { tenantId: tenantA.id, unitId: matriz.id, type: 'EXPENSE', description: 'Lançamento próprio da Matriz', amount: 10, dueAt: new Date() } });
  const revert = await call('POST', path('/rollback'), token, { confirm: 'REVERTER' });
  assert.ok([200, 202].includes(revert.status), JSON.stringify(revert.body));
  assert.equal(await prisma.financialEntry.count({ where: { tenantId: tenantA.id, unitId: filial.id } }), 0);
  assert.equal((await prisma.financialEntry.findUniqueOrThrow({ where: { id: own.id } })).description, 'Lançamento próprio da Matriz');
});
