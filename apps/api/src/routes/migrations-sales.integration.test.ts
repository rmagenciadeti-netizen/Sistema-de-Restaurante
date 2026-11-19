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
  'funcionarios.csv': 'Nome;CPF;Telefone;Cargo;Data de Admissão;Situação\nMaria Souza;529.982.247-25;(11) 98888-7777;Garçonete;10/03/2022;Ativo\nJoão Lima;;(11) 97777-6666;Cozinheiro;05/01/2021;Inativo\nMaria Souza;529.982.247-25;(11) 98888-7777;Garçonete;10/03/2022;Ativo\n',
  'produtos.csv': 'Codigo;Nome;Preco;Custo\nP1;Prato executivo;40,00;18,00\nP2;Suco;8,00;2,50\n',
  'clientes.csv': 'Nome;Telefone\nAna Souza;(11) 91234-5678\n',
  'vendas.csv': 'Numero venda;Data da venda;Total;Desconto;Taxa de serviço;Forma de pagamento;Cliente;Situação\n1001;15/03/2024;96,00;0;8,00;Cartão de crédito;Ana Souza;Fechada\n1002;16/03/2024;40,00;0;0;Dinheiro;;Fechada\n1003;17/03/2024;18,00;0;0;;;Fechada\n1004;18/03/2024;50,00;0;0;PIX;;Cancelada\n1005;19/03/2024;;0;0;PIX;;Fechada\n',
  'itens_venda.csv': 'Numero venda;Codigo produto;Produto;Quantidade;Preco unitario\n1001;P1;Prato executivo;2;40,00\n1001;P2;Suco;1;8,00\n1002;P1;Prato executivo;1;40,00\n1003;P9;Produto inexistente;1;18,00\n9999;P1;Prato executivo;1;40,00\n',
};

test('RM Smart Migration (employees + sales history): staged, imported as history only, linked, safe to re-run, isolated and reversible', { skip: !enabled, timeout: 180_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown, raw?: Buffer) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'application/octet-stream' } : {}) }, body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const tenantA = await prisma.tenant.create({ data: { name: `Sales A ${id}`, slug: `sales-a-${id}`, status: 'ACTIVE' } });
  const tenantB = await prisma.tenant.create({ data: { name: `Sales B ${id}`, slug: `sales-b-${id}`, status: 'ACTIVE' } });
  const master = await prisma.user.create({ data: { name: 'Operador RM', email: `ms-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const token = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });
  const otherEmployee = await prisma.employee.create({ data: { tenantId: tenantB.id, fullName: 'Maria Souza', cpf: '52998224725' } });

  const sid = (await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, token, { label: 'Legado com vendas', sourceUnknown: true })).body.id as string;
  const path = (suffix = '') => `/migrations/tenants/${tenantA.id}/sessions/${sid}${suffix}`;
  for (const [name, content] of Object.entries(CSV)) assert.equal((await call('POST', path(`/files?name=${name}`), token, undefined, Buffer.from(content))).status, 201);
  const analysis = await call('POST', path('/analyze'), token, {});
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  const tables = Object.values(analysis.body.mapping.tables) as any[];
  const entityOf = (file: string) => tables.find(table => String(table.name).includes(file))?.entity;
  assert.deepEqual(['funcionarios', 'produtos', 'clientes', 'vendas', 'itens_venda'].map(entityOf), ['EMPLOYEE', 'PRODUCT', 'CUSTOMER', 'SALE', 'SALE_ITEM']);
  assert.equal((await call('PUT', path('/mapping'), token, { tables: Object.fromEntries(tables.map(table => [table.key, { approved: true }])) })).status, 200);

  const preview = (await call('POST', path('/preview'), token, {})).body.summary;
  assert.equal(preview.byEntity.EMPLOYEE.total, 3); assert.equal(preview.byEntity.EMPLOYEE.DUPLICATE, 1, 'same CPF listed twice');
  assert.equal(preview.byEntity.SALE.total, 5); assert.equal(preview.byEntity.SALE.REJECTED, 1, 'a sale without a total is held back, never guessed');
  const approve = async () => { await call('POST', path('/bulk-approve'), token, {}); return call('POST', path('/approve'), token, { confirm: 'EXECUTAR' }); };
  assert.equal((await approve()).status, 200);
  const started = await call('POST', path('/execute'), token, {});
  assert.ok([200, 202].includes(started.status), JSON.stringify(started.body));
  let session: any;
  for (let attempt = 0; attempt < 60; attempt++) { session = (await call('GET', path(''), token)).body; if (['COMPLETED', 'INTERRUPTED'].includes(session.status)) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(session.status, 'COMPLETED', JSON.stringify(session.validation));

  // Employees: registration only, no access created.
  const employees = await prisma.employee.findMany({ where: { tenantId: tenantA.id }, orderBy: { fullName: 'asc' } });
  assert.deepEqual(employees.map(employee => [employee.fullName, employee.cpf, employee.status]), [['João Lima', null, 'INACTIVE'], ['Maria Souza', '52998224725', 'ACTIVE']]);
  assert.equal(employees[1].admissionDate!.toISOString().slice(0, 10), '2022-03-10');
  assert.equal(await prisma.user.count({ where: { tenantId: tenantA.id } }), 0, 'no user or password is created from a legacy system');

  // Sales: historical, original date and values, linked to the customer and the payment recorded as it was.
  const orders = await prisma.order.findMany({ where: { tenantId: tenantA.id }, include: { items: true, payments: true, customer: true }, orderBy: { code: 'asc' } });
  assert.deepEqual(orders.map(order => order.code), ['MIG-1001', 'MIG-1002', 'MIG-1003', 'MIG-1004']);
  const [s1, s2, s3, s4] = orders;
  assert.deepEqual([s1.status, Number(s1.total), Number(s1.serviceFee), Number(s1.subtotal), s1.createdAt.toISOString().slice(0, 10), s1.customer?.name], ['COMPLETED', 96, 8, 88, '2024-03-15', 'Ana Souza']);
  assert.deepEqual(s1.payments.map(payment => [payment.method, Number(payment.amount), payment.paidAt.toISOString().slice(0, 10), payment.integrated, payment.nsu]), [['CREDIT_CARD', 96, '2024-03-15', false, null]], 'a legacy card payment never receives NSU/authorisation data');
  assert.deepEqual(s1.items.map(item => [Number(item.quantity), Number(item.unitPrice), Number(item.total), item.unitCost]).sort(), [[1, 8, 8, null], [2, 40, 80, null]], 'item cost of an old sale is unknown, not estimated');
  assert.deepEqual([s2.payments[0].method, s2.items.length], ['CASH', 1]);
  assert.equal(s3.payments.length, 0, 'no payment method in the source: no payment invented'); assert.equal(s3.items.length, 0, 'item with an unknown product failed visibly');
  assert.deepEqual([s4.status, s4.payments.length], ['CANCELLED', 0]);
  const records = (await call('GET', path('/records?status=FAILED'), token)).body.items as any[];
  assert.deepEqual(records.map(record => record.entity).sort(), ['SALE_ITEM', 'SALE_ITEM']);
  assert.ok(records.some(record => /produto "P9"/.test(record.error)) && records.some(record => /venda "9999" não foi importada/.test(record.error)));
  const flagged = ((await call('GET', path('/records?status=IMPORTED&entity=SALE'), token)).body.items as any[]).find(record => record.original['Numero venda'] === '1003');
  assert.ok(flagged.issues.some((issue: any) => issue.code === 'no_payment_recorded'), 'flagged for review');
  // Nothing operational was triggered: no stock movement, production ticket or fiscal document.
  assert.equal(await prisma.fiscalDocument.count({ where: { tenantId: tenantA.id } }), 0);
  assert.equal(await prisma.printJob.count({ where: { orderId: { in: orders.map(order => order.id) } } }), 0);
  assert.equal(Number((await prisma.product.findFirstOrThrow({ where: { tenantId: tenantA.id, code: 'P1' } })).stockQuantity), 0);
  assert.equal(await prisma.employee.count({ where: { tenantId: tenantB.id } }), 1); assert.equal((await prisma.employee.findUniqueOrThrow({ where: { id: otherEmployee.id } })).fullName, 'Maria Souza', 'the other company is untouched');

  // Re-running never duplicates: the same files again report everything as existing.
  const sid2 = (await call('POST', `/migrations/tenants/${tenantA.id}/sessions`, token, { label: 'Reimport', sourceUnknown: true })).body.id as string;
  const path2 = (suffix = '') => `/migrations/tenants/${tenantA.id}/sessions/${sid2}${suffix}`;
  for (const [name, content] of Object.entries(CSV)) await call('POST', path2(`/files?name=${name}`), token, undefined, Buffer.from(content));
  const analysis2 = await call('POST', path2('/analyze'), token, {});
  await call('PUT', path2('/mapping'), token, { tables: Object.fromEntries((Object.values(analysis2.body.mapping.tables) as any[]).map(table => [table.key, { approved: true }])) });
  const preview2 = (await call('POST', path2('/preview'), token, {})).body.summary;
  assert.equal(preview2.byEntity.SALE.DUPLICATE, 4, 'sales already in the restaurant are not duplicated');
  await call('POST', path2('/bulk-approve'), token, {});
  assert.equal(await prisma.order.count({ where: { tenantId: tenantA.id } }), 4); assert.equal(await prisma.payment.count({ where: { tenantId: tenantA.id } }), 2);
  await prisma.migrationSession.update({ where: { id: sid2 }, data: { status: 'CANCELLED' } });

  // Reversal removes only what this migration created, items first; a sale that later received a payment is kept.
  await prisma.payment.create({ data: { tenantId: tenantA.id, orderId: s2.id, method: 'PIX', amount: 1, reference: 'manual-later' } });
  const rollback = await call('POST', path('/rollback'), token, { confirm: 'REVERTER' });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
  assert.ok(rollback.body.blocked.some((item: any) => item.entity === 'SALE' && /pagamentos/.test(item.reason)), 'a later payment protects the sale');
  assert.deepEqual((await prisma.order.findMany({ where: { tenantId: tenantA.id }, select: { code: true }, orderBy: { code: 'asc' } })).map(order => order.code), ['MIG-1002'], 'other sales were reverted');
  assert.equal(await prisma.employee.count({ where: { tenantId: tenantA.id } }), 0);
  assert.equal(await prisma.product.count({ where: { tenantId: tenantA.id } }), 0, 'products only go once no sale uses them');
});
