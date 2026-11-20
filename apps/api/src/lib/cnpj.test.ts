import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCnpj, isValidCnpj } from './cnpj';

test('validates CNPJ check digits, with or without mask', () => {
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11222333000181'), true);
  assert.equal(isValidCnpj('11.222.333/0001-82'), false);
  assert.equal(isValidCnpj('00000000000000'), false);
  assert.equal(isValidCnpj('123'), false);
  assert.equal(formatCnpj('11222333000181'), '11.222.333/0001-81');
});
