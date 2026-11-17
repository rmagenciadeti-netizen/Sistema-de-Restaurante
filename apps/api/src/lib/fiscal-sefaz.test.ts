import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SefazProvider, type SoapTransport } from './fiscal-sefaz';
import { mod11 } from './nfe-builder';
import { FiscalTransportError, type FiscalContext, type FiscalOrder } from './providers';
import { block, verifyXmlSignature, value } from './xml-signature';

const pfxBase64 = readFileSync(join(__dirname, '..', 'routes', 'fixtures', 'test-a1.pfx.b64'), 'utf8').trim();
const issuer = { legalName: 'RM Teste LTDA', tradeName: 'RM', cnpj: '12345678000195', stateRegistration: '131234567', municipalRegistration: '', cnae: '', taxRegime: 'SIMPLES_NACIONAL', street: 'Av. Getúlio Vargas', number: '100', complement: '', district: 'Centro', city: 'Cuiabá', cityIbge: '5103403', uf: 'MT', cep: '78005000', country: 'Brasil', countryCode: '1058', phone: '6533334444', contributorIndicator: '9' };
const context = (overrides: Partial<FiscalContext> = {}) => ({ environment: 'HOMOLOGATION', issuer, crt: 1, token: null, csc: { id: '000001', token: 'CSC-TESTE-123' }, certificate: { pfxBase64, password: 'teste123' }, contingency: false, ...overrides }) as unknown as FiscalContext;
const order = (kind: 'NFE' | 'NFCE'): FiscalOrder => ({
  orderId: 'order-1', ref: `doc-${kind}`, code: 'P1', total: '33.50', issuedAt: new Date('2026-11-17T15:00:00Z'), series: '1', number: '42', discount: '1.50',
  otherExpenses: kind === 'NFCE' ? '3.00' : undefined, freight: kind === 'NFE' ? '5.00' : undefined, nature: 'Venda de mercadoria', finality: '1',
  customer: kind === 'NFE' ? { name: 'Cliente Teste', document: '11144477735', contributorIndicator: '9', address: { street: 'Rua A', number: '1', district: 'Centro', city: 'Cuiabá', cityIbge: '5103403', uf: 'MT', cep: '78005000' } } : { name: null, document: null },
  payments: [{ method: 'PIX', amount: kind === 'NFE' ? '36.50' : '50.00' }],
  items: [
    { name: 'Marmita & cia', quantity: 1, unitPrice: '20.00', total: '20.00', code: 'M1', unit: 'UN', gtin: null, tax: { ncm: '21069090', cest: null, origin: 0, cfop: '5102', icmsCst: '102', icmsRate: null, icmsReduction: null, pisCst: '49', pisRate: null, cofinsCst: '49', cofinsRate: null } },
    { name: 'Suco', quantity: 1.5, unitPrice: '8.00', total: '12.00', code: 'S1', unit: 'L', gtin: '7891234567895', tax: { ncm: '20098990', cest: null, origin: 0, cfop: '5405', icmsCst: '500', icmsRate: null, icmsReduction: null, pisCst: '04', pisRate: null, cofinsCst: '04', cofinsRate: null } },
  ],
});
// Official XSDs (PL_010) are validated when NFE_XSD_DIR points to them and xmllint is installed.
const xsdDir = process.env.NFE_XSD_DIR;
function validate(xml: string, schema: string) {
  if (!xsdDir || !existsSync(join(xsdDir, schema))) return;
  const file = join(mkdtempSync(join(tmpdir(), 'nfe-')), 'doc.xml'); writeFileSync(file, xml);
  try { execFileSync('xmllint', ['--noout', '--schema', join(xsdDir, schema), file], { stdio: 'pipe' }); }
  catch (error) { assert.fail(`XSD ${schema}: ${String((error as { stderr?: Buffer }).stderr ?? error)}`); }
}
const inner = (envelope: string) => envelope.slice(envelope.indexOf('>', envelope.indexOf('<nfeDadosMsg')) + 1, envelope.indexOf('</nfeDadosMsg>'));
const soap = (body: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>${body}</nfeResultMsg></soap:Body></soap:Envelope>`;

test('access key check digit (mod 11) matches an authorized key', () => {
  // Example from the Manual de Orientação do Contribuinte (MOC), cDV = 5.
  const key = '52060433009911002506550120000007800267301615';
  assert.equal(String(mod11(key.slice(0, 43))), key[43]);
});

test('NFC-e is built, signed, gets QR Code v3 (homologação) and is authorized with nfeProc', async () => {
  const sent: { url: string; action: string; body: string }[] = [];
  const transport: SoapTransport = async (url, action, envelope, tls) => {
    assert.ok(tls.pfx.length > 0 && tls.passphrase === 'teste123', 'mutual TLS uses the A1 certificate');
    sent.push({ url, action, body: inner(envelope) });
    const key = /Id="NFe(\d{44})"/.exec(envelope)![1];
    return soap(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>MT</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-11-17T11:00:01-04:00</dhRecbto><nProt>151260000000001</nProt><digVal>abc=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe>`);
  };
  const result = await new SefazProvider(transport).emit(order('NFCE'), 'NFCE', context());
  assert.equal(result.status, 'AUTHORIZED'); assert.equal(result.protocol, '151260000000001'); assert.equal(result.accessKey!.length, 44);
  assert.equal(sent[0].url, 'https://homologacao.sefaz.mt.gov.br/nfcews/services/NfeAutorizacao4');
  assert.equal(sent[0].action, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote');
  const nfe = /<NFe [\s\S]*<\/NFe>/.exec(sent[0].body)![0];
  assert.ok(verifyXmlSignature(nfe, 'infNFe'), 'signature verifies');
  assert.equal(value(nfe, 'xProd'), 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
  assert.equal(value(nfe, 'vNF'), '33.50'); assert.equal(value(nfe, 'vTroco'), '16.50'); assert.equal(value(nfe, 'dhEmi'), '2026-11-17T11:00:00-04:00');
  assert.equal(value(nfe, 'qrCode'), `http://homologacao.sefaz.mt.gov.br/nfce/consultanfce?p=${result.accessKey}|3|2`);
  validate(sent[0].body, 'enviNFe_v4.00.xsd');
  assert.ok(result.xml!.startsWith('<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe'));
  validate(result.xml!, 'procNFe_v4.00.xsd');
});

test('NF-e (production, QR-less) keeps freight, recipient and validates; QR v2 hash uses the CSC', async () => {
  const provider = new SefazProvider(async () => { throw new Error('não usado'); });
  const nfe = provider.signDocument(order('NFE'), 'NFE', context());
  assert.ok(verifyXmlSignature(nfe.xml, 'infNFe')); validate(nfe.xml, 'nfe_v4.00.xsd');
  assert.equal(value(nfe.xml, 'xNome'), 'RM Teste LTDA'); assert.equal(value(block(nfe.xml, 'ICMSTot'), 'vFrete'), '5.00'); assert.equal(value(nfe.xml, 'mod'), '55');
  const nfce = provider.signDocument(order('NFCE'), 'NFCE', context({ environment: 'PRODUCTION' }));
  const seq = `${nfce.key}|2|1|1`;
  assert.equal(value(nfce.xml, 'qrCode'), `http://www.sefaz.mt.gov.br/nfce/consultanfce?p=${seq}|${createHash('sha1').update(seq + 'CSC-TESTE-123').digest('hex').toUpperCase()}`);
  validate(nfce.xml, 'nfe_v4.00.xsd');
});

test('lost answer keeps the key/XML for consultation; contingency NFC-e is signed off-line with tpEmis 9', async () => {
  const provider = new SefazProvider(async () => { throw new Error('socket hang up'); });
  await assert.rejects(provider.emit(order('NFCE'), 'NFCE', context()), (error: unknown) => error instanceof FiscalTransportError && error.accessKey!.length === 44 && error.xml!.includes('<Signature'));
  const offline = await provider.emit(order('NFCE'), 'NFCE', context({ contingency: true }));
  assert.equal(offline.status, 'PROCESSING'); assert.equal(offline.contingency, true); assert.equal(offline.accessKey![34], '9');
  assert.match(value(offline.xml!, 'qrCode')!, /\|3\|2\|17\|33\.50\|3\|\|[A-Za-z0-9+/=]+$/);
  validate(offline.xml!, 'nfe_v4.00.xsd');
});

test('consultation, cancellation, CC-e and inutilization speak the official layouts', async () => {
  const bodies: string[] = []; let reply = '';
  const provider = new SefazProvider(async (_url, _action, envelope) => { bodies.push(inner(envelope)); return soap(reply); });
  const key = '51261112345678000195550010000000421123456780';
  reply = '<retConsSitNFe versao="4.00"><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe>';
  assert.equal((await provider.consult({ ref: 'r', kind: 'NFE', number: '42', series: '1', accessKey: key }, context())).status, 'NOT_FOUND');
  validate(bodies.at(-1)!, 'consSitNFe_v4.00.xsd');
  reply = '<retEnvEvento versao="1.00"><cStat>128</cStat><retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><nProt>151260000000099</nProt></infEvento></retEvento></retEnvEvento>';
  const cancelled = await provider.cancel({ number: '42', accessKey: key, protocol: '151260000000001' }, 'Venda desfeita pelo cliente', context());
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.protocol, '151260000000099');
  validate(bodies.at(-1)!, 'envEventoCancNFe_v1.00.xsd'); assert.ok(verifyXmlSignature(bodies.at(-1)!, 'infEvento'));
  assert.equal((await provider.correct({ ref: 'r', kind: 'NFE', number: '42', series: '1', accessKey: key }, 'Corrige o endereço do destinatário', 2, context())).status, 'REGISTERED');
  validate(bodies.at(-1)!, 'envCCe_v1.00.xsd');
  reply = '<retInutNFe versao="4.00"><infInut><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><nProt>151260000000123</nProt></infInut></retInutNFe>';
  const inut = await provider.inutilize({ kind: 'NFCE', series: '1', numberFrom: 50, numberTo: 52, year: 2026, justification: 'Falha no sistema ao emitir a nota' }, context());
  assert.equal(inut.status, 'REGISTERED'); assert.equal(inut.protocol, '151260000000123');
  validate(bodies.at(-1)!, 'inutNFe_v4.00.xsd'); assert.ok(verifyXmlSignature(bodies.at(-1)!, 'infInut'));
  assert.ok(bodies.at(-1)!.includes('Id="ID5126' + '12345678000195' + '65' + '001' + '000000050' + '000000052"'));
  await assert.rejects(provider.emit(order('NFCE'), 'NFCE', context({ issuer: { ...issuer, uf: 'SP' } } as Partial<FiscalContext>)), /Focus NFe/);
});
