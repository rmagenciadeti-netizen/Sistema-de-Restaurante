import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage, hasAny, localToUtc, matchScore, normalizeText, parseWhen, samePhone } from './whatsapp-text';
import { renderTemplate } from './whatsapp-messages';

test('normalisation strips accents and punctuation; keyword matching uses whole words', () => {
  assert.equal(normalizeText('  Olá, Cardápio?! '), 'ola, cardapio');
  assert.ok(hasAny('Qual o horário de vocês?', ['horario']));
  assert.ok(!hasAny('quero reservar para 4 pessoas', ['humano', 'falar com pessoa']));
  assert.ok(!hasAny('o vale a pena', ['pix']));
});

test('phones match with or without country code and the ninth digit', () => {
  assert.ok(samePhone('5511999998888', '11999998888'));
  assert.ok(samePhone('551199998888', '11999998888'));
  assert.ok(!samePhone('5511999998888', '5511999997777'));
  assert.ok(!samePhone(null, '11999998888'));
});

test('product matching needs the distinctive words of the query', () => {
  assert.ok(matchScore('quanto custa o hamburguer artesanal?', 'Hambúrguer Artesanal') >= 2);
  assert.ok(matchScore('tem suco de laranja?', 'Suco de laranja') >= 2);
  assert.equal(matchScore('qual o horario', 'Hambúrguer Artesanal'), 0);
});

test('reservation date parsing understands local time zones, relative days and rejects bad input', () => {
  const now = new Date('2026-03-02T15:00:00Z'); // Monday 12:00 in São Paulo
  const tz = 'America/Sao_Paulo';
  const a = parseWhen('25/03 20:00', tz, now);
  assert.ok('at' in a && a.at.toISOString() === '2026-03-25T23:00:00.000Z');
  const tomorrow = parseWhen('amanhã 19h30', tz, now);
  assert.ok('at' in tomorrow && tomorrow.at.toISOString() === '2026-03-03T22:30:00.000Z');
  const saturday = parseWhen('sábado 21h', tz, now);
  assert.ok('at' in saturday && saturday.at.toISOString() === '2026-03-08T00:00:00.000Z');
  assert.deepEqual(parseWhen('hoje 12:10', tz, now), { error: 'PAST' });
  assert.deepEqual(parseWhen('31/02 20:00', tz, now), { error: 'INVALID' });
  assert.deepEqual(parseWhen('amanhã', tz, now), { error: 'NO_TIME' });
  assert.deepEqual(parseWhen('20h', tz, now), { error: 'NO_DATE' });
  assert.equal(localToUtc(2026, 3, 2, 12, 0, tz).toISOString(), '2026-03-02T15:00:00.000Z');
});

test('templates replace known variables and drop unknown ones; long replies are chunked', () => {
  assert.equal(renderTemplate('Oi {{nome}}, {{x}}fim', { nome: 'Ana' }), 'Oi Ana, fim');
  const chunks = chunkMessage(Array.from({ length: 200 }, (_, i) => `linha ${i} ${'x'.repeat(30)}`).join('\n'), 1000);
  assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.length <= 1000));
});
