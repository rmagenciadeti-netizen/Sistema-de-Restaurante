import test from 'node:test';
import assert from 'node:assert/strict';
import { marginSimulation, parseMenuLayout, replaceDaySlots, scaleBarcodeExample, serializeMenuLayout } from './settings-helpers.ts';

test('scale barcode example follows prefix + code + value + EAN check digit', () => {
  const example = scaleBarcodeExample({ prefix: '2', codeLength: 6, barcodeLength: 13, saleType: 'WEIGHT' }, 123, 1.25);
  assert.equal(example?.barcode.length, 13);
  assert.equal(example?.code, '000123');
  assert.equal(example?.amount, '01250');
  assert.equal(scaleBarcodeExample({ prefix: '2', codeLength: 6, barcodeLength: 9, saleType: 'WEIGHT' }, 1, 1), null);
  assert.equal(scaleBarcodeExample({ prefix: '2', codeLength: 3, barcodeLength: 12, saleType: 'PRICE' }, 1234, 1), null);
});

test('menu layout export/import keeps only known items', () => {
  const text = serializeMenuLayout(['/a', '/gone']);
  assert.deepEqual(parseMenuLayout(text, ['/a', '/b']), ['/a']);
  assert.equal(parseMenuLayout('{"x":1}', ['/a']), null);
  assert.equal(parseMenuLayout('nope', ['/a']), null);
});

test('margin simulation and day slot replacement', () => {
  assert.deepEqual(marginSimulation(10, 150), { price: 25, profit: 15 });
  const slots = replaceDaySlots([{ day: 1, start: '10:00', end: '12:00' }, { day: 2, start: '10:00', end: '12:00' }], 1, [{ day: 9, start: '18:00', end: '20:00' }, { day: 1, start: '08:00', end: '09:00' }]);
  assert.deepEqual(slots.map(slot => `${slot.day}${slot.start}`), ['108:00', '118:00', '210:00']);
});
