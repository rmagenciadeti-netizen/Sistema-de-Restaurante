import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStatement, parseOfx, parseStatementCsv } from './bank-statement';

test('parses OFX transactions with sign and date', () => {
  const ofx = '<OFX><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105120000<TRNAMT>150.50<MEMO>PIX RECEBIDO</STMTTRN><STMTTRN><DTPOSTED>20261106<TRNAMT>-80.00<NAME>FORNECEDOR</STMTTRN></OFX>';
  assert.deepEqual(parseOfx(ofx), [{ date: '2026-11-05', amount: 150.5, description: 'PIX RECEBIDO' }, { date: '2026-11-06', amount: -80, description: 'FORNECEDOR' }]);
});

test('parses Brazilian CSV statements', () => {
  const csv = 'Data;Descrição;Valor\n05/11/2026;Pix cliente;"1.234,56"\n06/11/2026;Aluguel;-2.000,00\nlixo;x;y';
  assert.deepEqual(parseStatementCsv(csv), [{ date: '2026-11-05', amount: 1234.56, description: 'Pix cliente' }, { date: '2026-11-06', amount: -2000, description: 'Aluguel' }]);
  assert.deepEqual(parseStatementCsv('a;b\n1;2'), []);
});

test('matches by signed amount within the date tolerance, one entry per line', () => {
  const entries = [
    { id: 'a', type: 'INCOME' as const, amount: 100, date: '2026-11-05', description: '' }, { id: 'b', type: 'INCOME' as const, amount: 100, date: '2026-11-07', description: '' },
    { id: 'c', type: 'EXPENSE' as const, amount: 100, date: '2026-11-05', description: '' }, { id: 'd', type: 'INCOME' as const, amount: 55, date: '2026-10-01', description: '' },
  ];
  const lines = [{ date: '2026-11-06', amount: 100, description: '' }, { date: '2026-11-06', amount: 100, description: '' }, { date: '2026-11-06', amount: 100, description: '' }, { date: '2026-11-06', amount: -100, description: '' }];
  const result = matchStatement(lines, entries);
  assert.deepEqual(result.matches.map(match => match.entryId), ['a', 'b', null, 'c']);
  assert.deepEqual(result.unmatchedEntries.map(entry => entry.id), ['d']);
});
