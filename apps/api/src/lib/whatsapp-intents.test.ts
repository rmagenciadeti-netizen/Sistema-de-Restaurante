import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, detectTopics, isGreetingOnly, isNo, isYes, menuChoice, parsePeople, wantsToResume, wantsToStop, weekdaysIn } from './whatsapp-intents';
import { extractWhen, parseWhen } from './whatsapp-text';

const topics = (text: string) => detectTopics(canonical(text)).map(item => item.topic);

test('slang, abbreviations and typos are read as the words they stand for', () => {
  assert.equal(canonical('Oiiii, vcs tem cardapo?'), 'oi voces tem cardapio');
  assert.equal(canonical('qro saber se tem promossao hj'), 'quero saber se tem promocao hoje');
  assert.equal(canonical('Obrigadooo!!'), 'obrigado');
  assert.equal(canonical('pq vcs fecham cedo?'), 'porque voces fecham cedo');
  assert.equal(canonical('endereço pfv'), 'endereco por favor');
  // Words that are not typos of anything we know stay untouched.
  assert.equal(canonical('pedra de sal'), 'pedra de sal');
});

test('one message can carry several subjects, answered in the order they were asked', () => {
  assert.deepEqual(topics('vcs ficam onde? aceitam pix? e qq a taxa pro jardim norte??'), ['address', 'payment', 'delivery']);
  assert.deepEqual(topics('Qual o horário e vocês entregam?'), ['hours', 'delivery']);
  assert.deepEqual(topics('quero ver o cardápio e saber as formas de pagamento'), ['menu', 'payment']);
  assert.deepEqual(topics('tem promoção hoje? e abre domingo?'), ['promo', 'hours']);
});

test('subjects that would be answered wrongly together are kept apart', () => {
  assert.deepEqual(topics('quero falar com um atendente sobre o horário'), ['handoff']);
  assert.deepEqual(topics('quero cancelar meu pedido'), ['cancel_existing']);
  assert.deepEqual(topics('cancelar a reserva de sábado'), ['cancel_existing']);
  assert.deepEqual(topics('cadê meu pedido? já saiu?'), ['order_status']);
  assert.deepEqual(topics('meu pedido demora?'), ['order_status']);
  assert.deepEqual(topics('quanto tempo demora a entrega?'), ['delivery']);
  assert.deepEqual(topics('vocês aceitam reservas?'), ['reserve']);
  assert.deepEqual(topics('aceitam?'), ['payment']);
  assert.deepEqual(topics('pedido 42'), ['order_status']);
  assert.deepEqual(topics('quero fazer um pedido'), ['order']);
  assert.deepEqual(topics('mesa pra 4 amanhã'), ['reserve']);
  assert.deepEqual(topics('obrigado!'), ['thanks']);
});

test('numbers of people are understood in everyday phrasing and never taken from the clock', () => {
  assert.equal(parsePeople(canonical('somos 4')), 4);
  assert.equal(parsePeople(canonical('4 pessoas')), 4);
  assert.equal(parsePeople(canonical('mesa pra quatro')), 4);
  assert.equal(parsePeople(canonical('pra 6 amanhã às 20h')), 6);
  assert.equal(parsePeople(canonical('sábado pra 20h')), null);
  assert.equal(parsePeople(canonical('sábado 21h')), null);
  assert.equal(parsePeople(canonical('eu e mais 3')), 4);
  assert.equal(parsePeople(canonical('um casal')), 2);
  assert.equal(parsePeople(canonical('somos em 5')), 5);
  assert.equal(parsePeople('4'), null);
  assert.equal(parsePeople('4', true), 4);
  assert.equal(parsePeople('quatro', true), 4);
  assert.equal(parsePeople(canonical('quero a mesa 4')), null);
});

test('yes, no, stop and resume phrases', () => {
  for (const yes of ['sim', 'Sim, pode confirmar', 'pode', 'isso mesmo', 'ok', 'fechado', 'claro']) assert.ok(isYes(canonical(yes)), yes);
  for (const no of ['não', 'nao, pra 6 pessoas', 'cancelar', 'deixa pra lá', 'melhor não']) assert.ok(isNo(canonical(no)), no);
  assert.ok(!isYes(canonical('simplesmente não sei')));
  for (const stop of ['cancelar', 'deixa pra lá', 'esquece isso', 'não quero mais', 'desisti']) assert.ok(wantsToStop(canonical(stop)), stop);
  assert.ok(!wantsToStop(canonical('quero reservar')));
  for (const resume of ['continuar a reserva', 'vamos retomar', 'voltando à reserva']) assert.ok(wantsToResume(canonical(resume)), resume);
});

test('greetings only count when nothing else is asked; numbered options map to subjects', () => {
  assert.ok(isGreetingOnly(canonical('Oii, tudo bem?')));
  assert.ok(isGreetingOnly(canonical('bom dia')));
  assert.ok(!isGreetingOnly(canonical('oi, qual o cardápio?')));
  assert.equal(menuChoice('1'), 'menu'); assert.equal(menuChoice('7'), 'reserve'); assert.equal(menuChoice('8'), 'handoff'); assert.equal(menuChoice('9'), null); assert.equal(menuChoice('12'), null);
  assert.deepEqual(weekdaysIn(canonical('e no sábado e domingo?')), [0, 6]);
});

test('date and time arrive together or in pieces, in everyday phrasing', () => {
  const now = new Date('2026-03-02T15:00:00Z'); // Monday 12:00 in São Paulo
  const tz = 'America/Sao_Paulo';
  const iso = (text: string) => { const parsed = parseWhen(text, tz, now); return 'at' in parsed ? parsed.at.toISOString() : parsed.error; };
  assert.equal(iso('amanhã 19h30'), '2026-03-03T22:30:00.000Z');
  assert.equal(iso('depois de amanhã às 20h'), '2026-03-04T23:00:00.000Z');
  assert.equal(iso('dia 25 às 20h'), '2026-03-25T23:00:00.000Z');
  assert.equal(iso('dia 1 às 20h'), '2026-04-01T23:00:00.000Z');
  assert.equal(iso('sábado meio-dia'), '2026-03-07T15:00:00.000Z');
  assert.equal(iso('sexta 8 da noite'), '2026-03-06T23:00:00.000Z');
  assert.equal(iso('amanhã, às 20h.'), '2026-03-03T23:00:00.000Z');
  assert.equal(iso('ontem às 20h'), 'PAST');
  assert.equal(iso('hj 12:10'), 'PAST');
  assert.deepEqual(extractWhen('Sábado'), { day: 'sabado' });
  assert.deepEqual(extractWhen('às 20h30'), { time: '20:30' });
  assert.deepEqual(extractWhen('amanhã 19h'), { day: 'amanha', time: '19:00' });
  assert.deepEqual(extractWhen('25/12 21:00'), { day: '25/12', time: '21:00' });
  assert.deepEqual(extractWhen('somos 4 pessoas'), {});
  assert.deepEqual(extractWhen('25h'), { invalid: true });
});
