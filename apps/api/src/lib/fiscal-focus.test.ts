import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusNfeProvider, focusPayload, spread } from './fiscal-focus';
import type { FiscalContext, FiscalOrder } from './providers';

const context = { environment: 'HOMOLOGATION', token: 'tok', issuer: { cnpj: '12345678000195', uf: 'MT' }, crt: 1, csc: null, certificate: null, contingency: false } as unknown as FiscalContext;
const order: FiscalOrder = {
  orderId: 'o1', ref: 'doc-1', code: 'P1', total: '30.00', issuedAt: new Date('2026-11-17T12:00:00Z'), series: '1', number: '7', discount: '1.00', freight: '2.00',
  customer: { name: 'Cliente', document: '12345678909' }, payments: [{ method: 'PIX', amount: '30.00' }],
  items: [
    { name: 'A', quantity: 1, unitPrice: '10.00', total: '10.00', tax: { ncm: '21069090', cest: null, origin: 0, cfop: '5102', icmsCst: '102', icmsRate: null, icmsReduction: null, pisCst: '49', pisRate: null, cofinsCst: '49', cofinsRate: null, ibsCbsCst: '000', cClassTrib: '000001', cbsRate: '0.9' } },
    { name: 'B', quantity: 2, unitPrice: '10.00', total: '20.00', tax: { ncm: '21069090', cest: null, origin: 0, cfop: '5102', icmsCst: '102', icmsRate: null, icmsReduction: null, pisCst: '49', pisRate: null, cofinsCst: '49', cofinsRate: null } },
  ],
};

test('document amounts are spread over items in cents without losing the remainder', () => {
  assert.deepEqual(spread(100, [1, 1, 1]), [33, 33, 34]);
  assert.deepEqual(spread(0, [5, 5]), [0, 0]);
});

test('Focus payload carries numbering, recipient, IBS/CBS only when configured and payment codes', () => {
  const payload = focusPayload(order, 'NFCE', context) as Record<string, any>;
  assert.equal(payload.numero, '7'); assert.equal(payload.cpf_destinatario, '12345678909');
  assert.equal(payload.items[0].ibs_cbs_classificacao_tributaria, '000001'); assert.equal('ibs_cbs_situacao_tributaria' in payload.items[1], false);
  assert.deepEqual(payload.items.map((item: any) => item.valor_desconto), ['0.33', '0.67']);
  assert.equal(payload.formas_pagamento[0].forma_pagamento, '17'); assert.equal(payload.modalidade_frete, 0);
});

test('an already used reference is resolved by consultation, never by a new emission', async () => {
  const requests: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('.xml')) return new Response('<nfeProc/>');
    if (init?.method === 'POST') return new Response(JSON.stringify({ codigo: 'already_processed', mensagem: 'A nota fiscal já foi autorizada' }), { status: 422 });
    return new Response(JSON.stringify({ status: 'autorizado', numero: '7', chave_nfe: 'NFe5'.padEnd(47, '1'), caminho_xml_nota_fiscal: '/x.xml', protocolo: '151' }));
  }) as typeof fetch;
  const result = await new FocusNfeProvider(fake).emit(order, 'NFCE', context);
  assert.equal(result.status, 'AUTHORIZED'); assert.equal(result.protocol, '151'); assert.equal(result.xml, '<nfeProc/>'); assert.equal(result.accessKey?.startsWith('5'), true);
  assert.deepEqual(requests.map(request => request.split('?')[0]), ['POST https://homologacao.focusnfe.com.br/v2/nfce', 'GET https://homologacao.focusnfe.com.br/v2/nfce/doc-1', 'GET https://homologacao.focusnfe.com.br/x.xml']);
});
