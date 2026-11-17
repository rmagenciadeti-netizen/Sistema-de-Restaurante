import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { fiscalProviders, type FiscalContext, type FiscalEmission, type FiscalOrder } from '../lib/providers';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';
const pfxBase64 = readFileSync(join(__dirname, 'fixtures', 'test-a1.pfx.b64'), 'utf8').trim();

test('fiscal module: settings, certificate, lost protocol, contingency, inutilization, PDV mode and XML export', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.FISCAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  const suffix = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`.toLowerCase(), status: 'ACTIVE' } });
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const tokens = {} as Record<'ADMIN' | 'CASHIER' | 'WAITER', string>;
    for (const role of [UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER] as const) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    }
    return { tenant, unit, tokens };
  };
  const A = await makeTenant('fiscal'); const B = await makeTenant('fiscalb');
  const admin = A.tokens.ADMIN;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fiscalProviders.clear();
    const tenantIds = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  // Fake provider that can lose the answer, fail or be consulted, recording every call.
  const calls: string[] = []; const sentContexts: FiscalContext[] = []; let mode: 'ok' | 'throw' = 'ok'; let consultAnswer: FiscalEmission['status'] = 'NOT_FOUND';
  const sent: FiscalOrder[] = [];
  fiscalProviders.clear();
  fiscalProviders.register({
    name: 'fake',
    emit: async (order, kind, context) => { calls.push(`emit:${order.number}`); sent.push(order); if (context) sentContexts.push(context); if (mode === 'throw') throw new Error('timeout'); return { status: 'AUTHORIZED', protocol: `P${order.number}`, accessKey: `${kind === 'NFE' ? '55' : '65'}${order.number}`.padEnd(44, '0'), xml: `<nfeProc><n>${order.number}</n></nfeProc>` }; },
    consult: async document => { calls.push(`consult:${document.number}`); return consultAnswer === 'AUTHORIZED' ? { status: 'AUTHORIZED', protocol: 'RECOVERED', xml: `<nfeProc><n>${document.number}</n><rec/></nfeProc>` } : { status: consultAnswer }; },
    cancel: async () => ({ cancelled: true, protocol: 'C1', xml: '<procEventoNFe>cancel</procEventoNFe>' }),
    correct: async (_document, _text, sequence) => ({ status: 'REGISTERED', protocol: `CCE${sequence}`, xml: `<procEventoNFe>cce ${sequence}</procEventoNFe>` }),
    inutilize: async request => ({ status: 'REGISTERED', protocol: `I${request.numberFrom}`, xml: `<procInutNFe>${request.numberFrom}-${request.numberTo}</procInutNFe>` }),
  });
  const rule = await prisma.taxRule.create({ data: { tenantId: A.tenant.id, name: 'Padrão', ncm: '21069090', cfop: '5102', icmsCst: '102', ibsCbsCst: '000', cClassTrib: '000001', cbsRate: 0.9 } });
  const product = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Marmita', price: 20 } });
  const place = async () => (await call('POST', '/orders', admin, { unitId: A.unit.id, items: [{ productId: product.id, quantity: 1 }] })).body;

  await t.test('settings, default tax rule and certificate are tenant scoped and never expose secrets', async () => {
    assert.equal((await call('GET', '/fiscal/settings', admin)).body.configured, false);
    assert.equal((await call('PUT', '/fiscal/settings', A.tokens.CASHIER, { pdvMode: 'FISCAL' })).status, 403);
    const saved = await call('PUT', '/fiscal/settings', admin, { provider: 'fake', providerToken: 'secret-token', defaultTaxRuleId: rule.id, issuer: { legalName: 'RM Teste LTDA', cnpj: '12.345.678/0001-95', stateRegistration: '131234567', uf: 'MT', cityIbge: '5103403', taxRegime: 'SIMPLES_NACIONAL' } });
    assert.equal(saved.status, 200); assert.equal(saved.body.environment, 'HOMOLOGATION'); assert.equal(saved.body.hasProviderToken, true); assert.equal(saved.body.issuer.cnpj, '12345678000195');
    assert.equal(JSON.stringify(saved.body).includes('secret-token'), false);
    const blocked = await call('PUT', '/fiscal/settings', admin, { environment: 'PRODUCTION' });
    assert.equal(blocked.status, 422); assert.match(blocked.body.message, /certificado/);
    assert.equal((await call('POST', '/fiscal/settings/certificate', admin, { pfxBase64, password: 'errada' })).status, 422);
    const cert = await call('POST', '/fiscal/settings/certificate', admin, { pfxBase64, password: 'teste123' });
    assert.equal(cert.status, 201); assert.equal(cert.body.certificate.cnpj, '12345678000195'); assert.equal(cert.body.certificate.state, 'VALID');
    assert.equal(JSON.stringify(cert.body).includes(pfxBase64.slice(0, 40)), false);
    assert.equal((await call('POST', '/fiscal/settings/certificate/test', admin)).body.ok, true);
    assert.equal((await call('GET', '/fiscal/settings', B.tokens.ADMIN)).body.configured, false, 'settings are per company');
  });

  await t.test('unit fiscal settings use the establishment issuer, certificate and independent numbering', async () => {
    const filial = await prisma.unit.create({ data: { tenantId: A.tenant.id, name: 'Filial' } });
    const unitAdminUser = await prisma.user.create({ data: { tenantId: A.tenant.id, unitId: filial.id, name: 'Unit Admin', email: `unit-${suffix}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
    const unitAdmin = signAccessToken({ userId: unitAdminUser.id, tenantId: A.tenant.id, unitId: filial.id, role: UserRole.ADMIN });
    const unitPath = `/fiscal/settings/units/${filial.id}`;
    const initial = await call('GET', unitPath, unitAdmin);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.issuer.cnpj, '12345678000195');
    assert.equal(initial.body.ownCertificate, false);
    const saved = await call('PUT', unitPath, unitAdmin, { issuer: { legalName: 'RM Filial LTDA', cnpj: '12345678000276', stateRegistration: '131234567', uf: 'MT', cityIbge: '5103403', taxRegime: 'SIMPLES_NACIONAL' } });
    assert.equal(saved.status, 200); assert.equal(saved.body.issuer.legalName, 'RM Filial LTDA');
    const certificate = await call('POST', `${unitPath}/certificate`, unitAdmin, { pfxBase64, password: 'teste123' });
    assert.equal(certificate.status, 201); assert.equal(certificate.body.certificate.cnpj, '12345678000195'); assert.ok(certificate.body.certificateWarnings.length > 0);
    assert.equal((await call('GET', `/fiscal/settings/units/${B.unit.id}`, unitAdmin)).status, 404);
    assert.equal((await call('GET', `/fiscal/settings/units/${A.unit.id}`, unitAdmin)).status, 404, 'unit users cannot read another establishment');
    assert.equal((await call('GET', '/fiscal/numbering', admin)).body.items.find((item: any) => item.kind === 'NFCE').nextNumber, 1, 'company numbering stays independent');
    assert.equal((await call('GET', '/fiscal/numbering', unitAdmin)).body.items.find((item: any) => item.kind === 'NFCE').nextNumber, 1, 'unit numbering starts independently');
    const order = (await call('POST', '/orders', admin, { unitId: filial.id, items: [{ productId: product.id, quantity: 1 }] })).body;
    const emitted = await call('POST', `/fiscal/orders/${order.id}/emit`, unitAdmin, { kind: 'NFCE' });
    assert.equal(emitted.status, 201); assert.equal(emitted.body.number, '1');
    assert.equal(sentContexts.at(-1)?.issuer.cnpj, '12345678000276');
    assert.equal((await call('GET', '/fiscal/numbering', unitAdmin)).body.items.find((item: any) => item.kind === 'NFCE').nextNumber, 2);
    assert.equal((await call('GET', '/fiscal/numbering', admin)).body.items.find((item: any) => item.kind === 'NFCE').nextNumber, 1);
  });

  let lost: any;
  await t.test('a lost return is consulted before any retry, keeping the number and never re-emitting', async () => {
    const order = await place();
    mode = 'throw';
    const failed = await call('POST', `/fiscal/orders/${order.id}/emit`, admin, { kind: 'NFCE' });
    assert.equal(failed.status, 502); assert.equal(failed.body.status, 'PROCESSING'); assert.equal(failed.body.environment, 'HOMOLOGATION');
    assert.equal(sent.at(-1)!.items[0].tax.cClassTrib, '000001', 'company default rule supplies IBS/CBS');
    mode = 'ok'; consultAnswer = 'AUTHORIZED'; calls.length = 0;
    const recovered = await call('POST', `/fiscal/orders/${order.id}/emit`, admin, { kind: 'NFCE' });
    assert.equal(recovered.status, 201); assert.equal(recovered.body.protocol, 'RECOVERED'); assert.equal(recovered.body.number, failed.body.number);
    assert.deepEqual(calls, [`consult:${failed.body.number}`], 'authorized at SEFAZ: no second emission');
    lost = recovered.body;
    const detail = await call('GET', `/fiscal/documents/${lost.id}`, admin);
    assert.deepEqual(detail.body.events.map((event: any) => `${event.type}:${event.status}`).reverse(), ['EMISSION:COMMUNICATION_FAILURE', 'CONSULT:AUTHORIZED']);
    assert.equal((await call('POST', `/fiscal/documents/${lost.id}/consult`, B.tokens.ADMIN)).status, 404);
  });

  await t.test('contingency keeps NFC-e pending and the batch transmission regularizes it', async () => {
    assert.equal((await call('POST', '/fiscal-registry/contingency/start', admin, { reason: 'SEFAZ MT fora do ar desde as 10h' })).status, 201);
    const order = await place(); mode = 'throw';
    const pending = await call('POST', `/fiscal/orders/${order.id}/emit`, admin, { kind: 'NFCE' });
    assert.equal(pending.body.status, 'CONTINGENCY'); assert.equal(pending.body.contingency, true);
    const panel = await call('GET', '/fiscal-registry/contingency', admin);
    assert.ok(panel.body.pending.some((doc: any) => doc.id === pending.body.id && doc.status === 'CONTINGENCY'));
    mode = 'ok'; consultAnswer = 'NOT_FOUND'; calls.length = 0;
    const sentBatch = await call('POST', '/fiscal/documents/transmit', admin, { ids: [pending.body.id] });
    assert.equal(sentBatch.body.results[0].status, 'AUTHORIZED');
    assert.deepEqual(calls, [`consult:${pending.body.number}`, `emit:${pending.body.number}`], 'consulted first, then sent with the same number');
    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: pending.body.id } });
    assert.equal(doc.contingency, true); assert.equal(doc.status, 'AUTHORIZED');
    await call('POST', '/fiscal-registry/contingency/end', admin);
  });

  await t.test('inutilization validates the range, reserves future numbers and is available to the PDV', async () => {
    const numbering = (await call('GET', '/fiscal/numbering', admin)).body.items.find((item: any) => item.kind === 'NFCE');
    const used = Number(lost.number);
    const body = (numberFrom: number, numberTo: number) => ({ kind: 'NFCE', series: numbering.series, numberFrom, numberTo, justification: 'Falha no sistema ao emitir a nota' });
    assert.equal((await call('POST', '/fiscal/inutilizations', admin, body(used, used + 1))).status, 409, 'used numbers are blocked');
    assert.equal((await call('POST', '/fiscal/inutilizations', A.tokens.WAITER, body(900, 901))).status, 403);
    assert.equal((await call('POST', '/fiscal/inutilizations', admin, { ...body(5, 4) })).status, 400);
    const next = numbering.nextNumber;
    const ok = await call('POST', '/fiscal/inutilizations', A.tokens.CASHIER, body(next, next + 2));
    assert.equal(ok.status, 201); assert.equal(ok.body.protocol, `I${next}`);
    assert.equal((await call('GET', '/fiscal/numbering', admin)).body.items.find((item: any) => item.kind === 'NFCE').nextNumber, next + 3, 'inutilized numbers are never issued');
    assert.equal((await call('POST', '/fiscal/inutilizations', admin, body(next + 1, next + 5))).status, 409, 'overlapping range');
    assert.equal((await call('GET', '/fiscal/inutilizations', B.tokens.ADMIN)).body.total, 0);
  });

  await t.test('PDV fiscal behaviour: ask, never skip a mandatory emission, decide once', async () => {
    await call('PUT', '/fiscal/settings', admin, { pdvMode: 'ASK' });
    const order = await place();
    assert.equal((await call('POST', `/fiscal/orders/${order.id}/checkout`, A.tokens.CASHIER, {})).status, 400);
    const skipped = await call('POST', `/fiscal/orders/${order.id}/checkout`, A.tokens.CASHIER, { emit: false });
    assert.equal(skipped.body.fiscalMode, 'NON_FISCAL');
    assert.equal((await call('POST', `/fiscal/orders/${order.id}/checkout`, A.tokens.CASHIER, { emit: true })).status, 409, 'never asked twice');
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(stored.fiscalMode, 'NON_FISCAL'); assert.ok(stored.fiscalDecidedById && stored.fiscalDecidedAt);
    await call('PUT', '/fiscal/settings', admin, { pdvMode: 'FISCAL' });
    const fiscal = await place();
    assert.equal((await call('POST', `/fiscal/orders/${fiscal.id}/checkout`, A.tokens.CASHIER, { emit: false })).status, 409);
    const emitted = await call('POST', `/fiscal/orders/${fiscal.id}/checkout`, A.tokens.CASHIER, {});
    assert.equal(emitted.body.fiscalMode, 'FISCAL'); assert.equal(emitted.body.document.status, 'AUTHORIZED');
  });

  await t.test('CFOP follows the destination: rule interstate CFOP, operation nature and company defaults', async () => {
    const order = await place();
    const address = { street: 'Rua B', number: '2', district: 'Centro', city: 'São Paulo', cityIbge: '3550308', uf: 'SP', cep: '01001000' };
    const recipient = { name: 'Cliente SP', document: '11144477735', address };
    const cfopOf = async (body: object) => (await call('POST', `/fiscal/orders/${order.id}/preview`, admin, { kind: 'NFE', recipient, ...body })).body.document;
    assert.equal((await cfopOf({})).items[0].tax.cfop, '5102', 'no interstate CFOP anywhere: the rule CFOP is kept');
    assert.equal((await call('PUT', '/fiscal/settings', admin, { cfop: { saleInterstate: '6101' } })).body.cfop.saleInterstate, '6101');
    const company = await cfopOf({}); assert.equal(company.items[0].tax.cfop, '6101'); assert.equal(company.destination, '2');
    await prisma.operationNature.create({ data: { tenantId: A.tenant.id, name: 'Venda interestadual', cfop: '6108', destination: 'INTERSTATE', ufDestination: 'SP' } });
    assert.equal((await cfopOf({ nature: 'Venda interestadual' })).items[0].tax.cfop, '6108', 'matching nature beats the company default');
    await prisma.taxRule.update({ where: { id: rule.id }, data: { cfopInterstate: '6102' } });
    assert.equal((await cfopOf({ nature: 'Venda interestadual' })).items[0].tax.cfop, '6102', 'rule interstate CFOP wins');
    const inState = await call('POST', `/fiscal/orders/${order.id}/preview`, admin, { kind: 'NFE', recipient: { ...recipient, address: { ...address, uf: 'MT' } } });
    assert.equal(inState.body.document.items[0].tax.cfop, '5102'); assert.equal(inState.body.document.destination, undefined);
    assert.equal((await call('POST', '/fiscal-registry/natures', admin, { name: 'Inválida', cfop: '5102', taxRuleId: '00000000-0000-4000-8000-000000000000' })).status, 400);
    await call('PUT', '/fiscal/settings', admin, { cfop: {} });
    await prisma.taxRule.update({ where: { id: rule.id }, data: { cfopInterstate: null } });
  });

  await t.test('NF-e with CC-e and cancellation; XML export returns the stored files in a ZIP', async () => {
    const order = await place();
    const preview = await call('POST', `/fiscal/orders/${order.id}/preview`, admin, { kind: 'NFE', items: [{ index: 0, cfop: '5405' }] });
    assert.equal(preview.status, 200); assert.equal(preview.body.document.items[0].tax.cfop, '5405');
    assert.equal(await prisma.taxRule.count({ where: { id: rule.id, cfop: '5102' } }), 1, 'document edits never change the registered rule');
    const nfe = await call('POST', `/fiscal/orders/${order.id}/emit`, admin, { kind: 'NFE', nature: 'Venda', freight: 5, recipient: { name: 'Cliente', document: '123.456.789-09' }, items: [{ index: 0, cfop: '5405' }] });
    assert.equal(nfe.status, 201); assert.equal(sent.at(-1)!.items[0].tax.cfop, '5405'); assert.equal(sent.at(-1)!.freight, '5.00');
    assert.equal((await call('POST', `/fiscal/documents/${nfe.body.id}/correction`, admin, { text: 'curta' })).status, 400);
    assert.equal((await call('POST', `/fiscal/documents/${nfe.body.id}/correction`, admin, { text: 'Corrige o endereço do destinatário' })).body.sequence, 1);
    assert.equal((await call('POST', `/fiscal/documents/${nfe.body.id}/cancel`, admin, { reason: 'Venda desfeita pelo cliente' })).body.status, 'CANCELLED');

    const response = await fetch(`${base}/fiscal/xml/export`, { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
    const zip = Buffer.from(await response.arrayBuffer());
    const files: Record<string, string> = {};
    for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
      const size = zip.readUInt32LE(offset + 18); const nameLength = zip.readUInt16LE(offset + 26);
      const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
      files[name] = inflateRawSync(zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size)).toString();
      offset += 30 + nameLength + size;
    }
    const names = Object.keys(files);
    assert.ok(names.every(name => name.startsWith('homologacao/')));
    assert.ok(names.some(name => name.includes('/eventos/cce-1-')) && names.some(name => name.includes('/eventos/inutilizacao-')) && names.some(name => name.includes('/eventos/cancelamento-')));
    assert.ok(Object.values(files).includes(`<nfeProc><n>${lost.number}</n><rec/></nfeProc>`), 'XML exported byte-for-byte');
    assert.equal((await fetch(`${base}/fiscal/xml/export`, { headers: { authorization: `Bearer ${B.tokens.ADMIN}` } })).status, 404);
  });
});
