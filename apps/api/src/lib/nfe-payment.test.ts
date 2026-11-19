import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNFe } from './nfe-builder';
import type { FiscalContext, FiscalOrder } from './providers';

const issuer = { legalName: 'RM Teste LTDA', tradeName: 'RM', cnpj: '12345678000195', stateRegistration: '131234567', municipalRegistration: '', cnae: '', taxRegime: 'SIMPLES_NACIONAL', street: 'Av. Getúlio Vargas', number: '100', complement: '', district: 'Centro', city: 'Cuiabá', cityIbge: '5103403', uf: 'MT', cep: '78005000', country: 'Brasil', countryCode: '1058', phone: '6533334444', contributorIndicator: '9' };
const ctx = { environment: 'HOMOLOGATION', issuer, crt: 1, token: null, csc: { id: '000001', token: 'CSC-TESTE-123' }, certificate: null, contingency: false } as unknown as FiscalContext;
const sale = (payments: FiscalOrder['payments']): FiscalOrder => ({
  orderId: 'o1', ref: 'doc-1', code: 'P1', total: '100.00', issuedAt: new Date('2026-11-17T15:00:00Z'), series: '1', number: '42', nature: 'Venda de mercadoria', finality: '1', customer: { name: null, document: null }, payments,
  items: [{ name: 'Prato', quantity: 1, unitPrice: '100.00', total: '100.00', code: 'M1', unit: 'UN', gtin: null, tax: { ncm: '21069090', cest: null, origin: 0, cfop: '5102', icmsCst: '102', icmsRate: null, icmsReduction: null, pisCst: '49', pisRate: null, cofinsCst: '49', cofinsRate: null } }],
});
const pag = (payments: FiscalOrder['payments']) => /<pag>.*<\/pag>/s.exec(buildNFe(sale(payments), 'NFCE', ctx).xml)![0];

test('card paid through TEF reports tpIntegra 1 with the REAL acquirer CNPJ, brand and authorisation', () => {
  const xml = pag([{ method: 'CREDIT_CARD', amount: '100.00', integrated: true, acquirerCnpj: '11222333000181', cardBrand: 'Mastercard', authorizationCode: 'A1B2C3' }]);
  assert.match(xml, /<tPag>03<\/tPag><vPag>100\.00<\/vPag><card><tpIntegra>1<\/tpIntegra><CNPJ>11222333000181<\/CNPJ><tBand>02<\/tBand><cAut>A1B2C3<\/cAut><\/card>/);
});

test('card typed by hand stays not integrated (tpIntegra 2) and never receives made-up data', () => {
  assert.match(pag([{ method: 'DEBIT_CARD', amount: '100.00' }]), /<tPag>04<\/tPag><vPag>100\.00<\/vPag><card><tpIntegra>2<\/tpIntegra><\/card>/);
});

test('integrated card with missing provider data stops the document instead of presuming values', () => {
  for (const missing of [{ acquirerCnpj: null }, { cardBrand: null }, { authorizationCode: null }, { acquirerCnpj: '123' }]) {
    assert.throws(() => pag([{ method: 'CREDIT_CARD', amount: '100.00', integrated: true, acquirerCnpj: '11222333000181', cardBrand: 'VISA', authorizationCode: 'X1', ...missing }]), /sem CNPJ da adquirente, bandeira ou código de autorização/);
  }
});

test('PIX integrated, cash and mixed payments are reported per payment and sum to the total', () => {
  const xml = pag([{ method: 'CASH', amount: '30.00' }, { method: 'PIX', amount: '30.00', integrated: true, acquirerCnpj: '11222333000181', pixEndToEnd: 'E123' }, { method: 'CREDIT_CARD', amount: '40.00', integrated: true, acquirerCnpj: '11222333000181', cardBrand: 'VISA', authorizationCode: 'Z9' }]);
  assert.match(xml, /<tPag>01<\/tPag><vPag>30\.00<\/vPag><\/detPag>/);
  assert.match(xml, /<tPag>17<\/tPag><vPag>30\.00<\/vPag><card><tpIntegra>1<\/tpIntegra><CNPJ>11222333000181<\/CNPJ><\/card>/);
  assert.match(xml, /<tPag>03<\/tPag><vPag>40\.00<\/vPag><card><tpIntegra>1<\/tpIntegra>.*<tBand>01<\/tBand><cAut>Z9<\/cAut>/);
  assert.equal([...xml.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].reduce((sum, match) => sum + Number(match[1]), 0), 100);
  assert.ok(!xml.includes('E123'), 'EndToEnd has no field in the 4.00 payment group: it is kept in the payment record, not forced into the XML');
});

test('an unpaid or partly paid NFC-e is refused: no "Outros" (99) line is invented; NF-e without payment is "sem pagamento" (90)', () => {
  assert.throws(() => pag([]), /Pagamento confirmado \(0\.00\) menor que o total/);
  assert.throws(() => pag([{ method: 'CASH', amount: '60.00' }]), /menor que o total/);
  const nfe = /<pag>.*<\/pag>/s.exec(buildNFe({ ...sale([]), customer: { name: 'Cliente', document: '12345678909', address: { street: 'Rua A', number: '1', district: 'Centro', city: 'Cuiabá', cityIbge: '5103403', uf: 'MT', cep: '78000000' } } as FiscalOrder['customer'] }, 'NFE', ctx).xml)![0];
  assert.match(nfe, /<tPag>90<\/tPag><vPag>0\.00<\/vPag>/); assert.ok(!nfe.includes('<tPag>99'));
});

test('voucher paid through TEF is an integrated card-family payment with the provider\'s real data', () => {
  assert.match(pag([{ method: 'VOUCHER', amount: '100.00', integrated: true, acquirerCnpj: '11222333000181', cardBrand: 'Alelo', authorizationCode: 'V1' }]), /<tPag>10<\/tPag><vPag>100\.00<\/vPag><card><tpIntegra>1<\/tpIntegra><CNPJ>11222333000181<\/CNPJ>/);
});
