import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidCnpj, maskCnpj } from './cnpj.ts';

test('CNPJ validation and mask', () => {
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11.222.333/0001-80'), false);
  assert.equal(isValidCnpj('11111111111111'), false);
  assert.equal(maskCnpj('11222333000181'), '11.222.333/0001-81');
  assert.equal(maskCnpj('112223'), '11.222.3');
});
