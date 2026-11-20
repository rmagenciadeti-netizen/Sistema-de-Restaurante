import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { UserRole } from '@prisma/client';
import screensIndex from './screens.generated.json';
import { PROCEDURES } from './procedures';
import { SCREEN_BY_HREF, answerGuide, explainScreen, normalize } from './engine';

const repoRoot = resolve(__dirname, '../../../../..');
const lower = (text: string) => normalize(text);

test('the guide index matches the real screens (regenerate with scripts/generate-guide-screens.mjs when a screen changes)', () => {
  const run = spawnSync('node', ['--import', 'tsx', 'scripts/generate-guide-screens.mjs', '--check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

test('every procedure points to a real menu entry, tab, field and button', () => {
  const ids = new Set<string>();
  const groups = new Set((screensIndex.groups as { title: string }[]).map(group => group.title));
  const entries = Object.fromEntries([...SCREEN_BY_HREF.values()].flatMap(screen => screen.menu).map(item => [`${item.group}|${normalize(item.label)}`, true]));
  for (const procedure of PROCEDURES) {
    assert.ok(!ids.has(procedure.id), `duplicate id ${procedure.id}`); ids.add(procedure.id);
    const screen = SCREEN_BY_HREF.get(procedure.href);
    assert.ok(screen, `${procedure.id}: screen ${procedure.href} does not exist`);
    assert.ok(screen.menu.some(item => item.href === procedure.menuHref), `${procedure.id}: menu entry ${procedure.menuHref} does not exist`);
    if (procedure.tab) assert.ok(screen.tabs.includes(procedure.tab), `${procedure.id}: tab "${procedure.tab}" does not exist (${screen.tabs.join(' | ')})`);
    if (screen.module) assert.equal(procedure.module, screen.module, `${procedure.id}: module differs from the one that licenses ${procedure.href}`);
    for (const field of procedure.fields) assert.ok(SCREEN_BY_HREF.get(field.screen ?? procedure.href)?.fields.some(item => item.label === field.label), `${procedure.id}: field "${field.label}" is not on ${field.screen ?? procedure.href}`);
    for (const button of procedure.buttons ?? []) assert.ok(screen.buttons.includes(button), `${procedure.id}: button "${button}" is not on ${procedure.href}`);
    for (const id of procedure.related ?? []) assert.ok(PROCEDURES.some(item => item.id === id), `${procedure.id}: related ${id} does not exist`);
    for (const step of procedure.steps) for (const match of step.matchAll(/(?:Abra|abra) (?:o menu lateral › )?([^›.;]+?) › ([^.;:(,"]+)/g)) {
      const group = match[1].trim(); const label = normalize(match[2]);
      assert.ok(groups.has(group), `${procedure.id}: menu group "${group}" does not exist`);
      assert.ok(Object.keys(entries).some(key => key.startsWith(`${group}|`) && (key.slice(group.length + 1).startsWith(label) || label.startsWith(key.slice(group.length + 1)))), `${procedure.id}: menu path "${group} › ${match[2].trim()}" does not exist`);
    }
  }
});

test('tabs and sections quoted in the steps exist on a real screen', () => {
  const tabs = new Set([...SCREEN_BY_HREF.values()].flatMap(screen => screen.tabs));
  for (const procedure of PROCEDURES) for (const step of procedure.steps) for (const match of step.matchAll(/(?:aba|seção) "([^"]+)"/g)) assert.ok(tabs.has(match[1]) || [...tabs].some(tab => tab.endsWith(match[1])), `${procedure.id}: tab "${match[1]}" does not exist`);
});

const ask = (question: string, extra: { page?: string; role?: UserRole; modules?: string[] | null } = {}) => answerGuide(question, { page: extra.page, role: extra.role ?? UserRole.ADMIN, enabledModules: extra.modules });

test('real questions from every area get the right procedure with menu path, fields, verification and common mistakes', () => {
  const cases: [string, string][] = [
    ['Como cadastro um produto?', 'produto-cadastrar'], ['Como configuro o NCM e o CFOP?', 'ncm-cfop'], ['Como cadastro a tributação?', 'tributacao-empresa'],
    ['Como faço uma entrada de mercadoria?', 'entrada-mercadoria'], ['Como configuro uma mesa?', 'mesa-configurar'], ['Como libero acesso para um funcionário?', 'usuario-liberar-acesso'],
    ['Como faço o fechamento do caixa?', 'caixa-abrir-fechar'], ['Como emito uma nota fiscal?', 'nota-emitir'], ['Como consulto meu lucro?', 'lucro-consultar'],
    ['como abrir o caixa', 'caixa-abrir-fechar'], ['como faço o inventário do estoque', 'inventario'], ['como cadastro um fornecedor', 'entrada-mercadoria'], ['como crio um cupom de desconto', 'cupom-promocao'],
    ['como cadastrar categoria', 'categoria-cardapio'], ['como configurar o certificado digital', 'fiscal-configurar'], ['como funciona o KDS da cozinha', 'kds-operar'], ['como cadastro um entregador', 'entregador-cadastrar'],
    ['como configuro as zonas de entrega', 'delivery-zonas'], ['como faço uma venda no PDV', 'pdv-vender'], ['como lançar uma conta a pagar', 'conta-pagar-receber'], ['como cadastro um cliente', 'cliente-cadastrar'],
    ['como configuro uma impressora da cozinha', 'setor-producao'], ['como configuro comissão', 'comissao-configurar'], ['como monto a escala dos funcionários', 'escala-criar'], ['como conciliar o extrato bancário', 'bank-reconciliation'],
  ];
  for (const [question, expected] of cases) {
    const result = ask(question);
    assert.equal(result.matched, true, question);
    assert.equal(result.topic?.id, expected, `${question} → ${result.topic?.id}`);
    assert.ok(result.topic!.menuPath.length > 5 && result.steps!.length >= 2 && result.verify!.length >= 1, question);
  }
  const product = ask('Como cadastro um produto?');
  assert.match(product.answer, /Menu lateral › Gerenciamento de produtos › Produtos/);
  assert.match(product.answer, /Preço de venda \(R\$\)/); assert.match(product.answer, /Erros comuns/); assert.match(product.answer, /Como conferir/);
  assert.match(ask('Como configuro o NCM e o CFOP?').answer, /contador/);
  assert.match(ask('Como faço o fechamento do caixa?').answer, /computador/);
});

test('every procedure is found by its own title and by its aliases', () => {
  for (const procedure of PROCEDURES) {
    const byTitle = ask(`Como ${procedure.title.charAt(0).toLowerCase()}${procedure.title.slice(1)}?`);
    assert.equal(byTitle.topic?.id, procedure.id, `title of ${procedure.id} → ${byTitle.topic?.id}`);
    for (const alias of procedure.aliases.slice(0, 2)) assert.equal(ask(`como faço ${alias}`).topic?.id, procedure.id, `alias "${alias}" of ${procedure.id}`);
  }
});

test('field questions explain the field and point to its screen; data questions are left to the data assistant', () => {
  const cfop = ask('o que é CFOP?');
  assert.equal(cfop.kind, 'field'); assert.match(cfop.answer, /CFOP/); assert.match(cfop.answer, /Fiscal \/ Tributos/);
  assert.equal(ask('o que é NCM?').kind, 'field');
  for (const question of ['Quanto vendi hoje?', 'Qual produto vende mais?', 'Quais produtos preciso comprar?', 'Qual a previsão de faturamento do mês?', 'Como está meu faturamento?']) assert.equal(ask(question).matched, false, question);
});

test('when unsure the guide says so instead of teaching something incorrect', () => {
  const result = ask('como configuro o teletransporte de mesas');
  assert.equal(result.kind, 'fallback'); assert.equal(result.confidence, 'low');
  assert.match(result.answer, /Não tenho certeza/); assert.doesNotMatch(result.answer, /Passo a passo/);
});

test('answers respect the role and the company license without hiding the lesson', () => {
  const cashier = ask('como emito uma nota fiscal', { role: UserRole.CASHIER, modules: ['fiscal'] });
  assert.equal(cashier.access?.canEdit, true);
  const waiter = ask('como configuro o certificado digital', { role: UserRole.WAITER, modules: ['fiscal'] });
  assert.equal(waiter.access?.canView, false); assert.match(waiter.answer, /Seu perfil não acessa/);
  const noModule = ask('como emito uma nota fiscal', { modules: ['pos'] });
  assert.equal(noModule.access?.moduleAvailable, false); assert.match(noModule.answer, /não está habilitada no plano/);
  assert.equal(ask('como emito uma nota fiscal', { modules: null }).access?.moduleAvailable, true, 'no license row = everything open');
});

test('"explain this screen" is built from the real screen: menu path, tabs, fields, buttons and the tasks available', () => {
  const screen = explainScreen('/products', UserRole.ADMIN, null);
  assert.equal(screen.kind, 'screen');
  for (const expected of ['Menu lateral › Gerenciamento de produtos › Produtos', 'Preço de venda (R$)', 'Fiscal', 'Adicionar produto', 'Cadastrar um produto']) assert.ok(screen.answer.includes(expected), expected);
  assert.equal(ask('explique esta tela', { page: '/cash' }).kind, 'screen');
  assert.equal(explainScreen('/rota-que-nao-existe', UserRole.ADMIN, null).kind, 'fallback');
  assert.match(screen.notice, /não altera/);
});

test('every real screen can be explained', () => {
  for (const screen of SCREEN_BY_HREF.values()) {
    const result = explainScreen(screen.href, UserRole.ADMIN, null);
    assert.equal(result.kind, 'screen', screen.href); assert.ok(lower(result.answer).includes('tela'), screen.href);
  }
});
