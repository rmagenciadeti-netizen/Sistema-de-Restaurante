import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidAccessKey, parseNfeXml } from './nfe-xml';

function keyWithDigit(base: string) {
  let sum = 0; let weight = 2;
  for (let index = 42; index >= 0; index--) { sum += Number(base[index]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const remainder = sum % 11;
  return base + String(remainder < 2 ? 0 : 11 - remainder);
}
const key = keyWithDigit('3526111234567800019055001000000123100000123');
const xml = (accessKey = key) => `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe versao="4.00" Id="NFe${accessKey}">
<ide><serie>1</serie><nNF>123</nNF><dhEmi>2026-11-10T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>12345678000190</CNPJ><xNome>Frios &amp; Cia</xNome></emit>
<det nItem="1"><prod><xProd>Queijo</xProd><NCM>04061010</NCM><CFOP>5102</CFOP><qCom>2.0000</qCom><vUnCom>10.50</vUnCom><vProd>21.00</vProd></prod></det>
<det nItem="2"><prod><xProd>Presunto</xProd><NCM>16024900</NCM><CFOP>5102</CFOP><qCom>1.0000</qCom><vUnCom>9.00</vUnCom><vProd>9.00</vProd></prod></det>
<total><ICMSTot><vNF>30.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;

test('access key check digit is validated', () => {
  assert.equal(isValidAccessKey(key), true);
  assert.equal(isValidAccessKey(key.slice(0, 43) + String((Number(key[43]) + 1) % 10)), false);
  assert.equal(isValidAccessKey('123'), false);
});

test('NF-e XML is parsed into supplier, totals and items', () => {
  const parsed = parseNfeXml(xml());
  assert.equal(parsed.accessKey, key);
  assert.equal(parsed.number, '123');
  assert.equal(parsed.supplierName, 'Frios & Cia');
  assert.equal(parsed.supplierDocument, '12345678000190');
  assert.equal(parsed.totalAmount, 30);
  assert.deepEqual(parsed.items.map(item => [item.description, item.quantity, item.totalValue]), [['Queijo', 2, 21], ['Presunto', 1, 9]]);
});

test('invalid or hostile XML is rejected', () => {
  assert.throws(() => parseNfeXml(xml(key.slice(0, 43) + String((Number(key[43]) + 1) % 10))), /Chave de acesso/);
  assert.throws(() => parseNfeXml('<!DOCTYPE x [<!ENTITY a "b">]>' + xml()), /DOCTYPE/);
  assert.throws(() => parseNfeXml('<foo/>'), /Chave de acesso/);
});
