import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFields } from './fields';
import { LEGACY_FINANCE_DUMP } from './legacy-finance.fixture';
import { suggestMapping, tableKey } from './mapper';
import { detectDateOrder, normalizeState, normalizeZip, parseDateValue, parseEntryStatus, parseInstallment } from './normalize';
import { financialTotals, stageTablesDetailed, type ExistingData, type StagedRecord } from './pipeline';
import { readSource } from './readers';

const empty: ExistingData = { categories: [], products: [], customers: [], suppliers: [] };
const today = new Date('2026-03-01T12:00:00Z');
const load = () => {
  const { tables } = readSource('legado.sql', Buffer.from(LEGACY_FINANCE_DUMP));
  const { mapping } = suggestMapping(tables);
  for (const table of Object.values(mapping.tables)) table.approved = table.entity !== 'IGNORE';
  return { tables, mapping };
};
const named = (records: StagedRecord[], entity: string, key: string, value: unknown) => records.find(record => record.entity === entity && record.normalized[key] === value)!;

test('unknown legacy system: all six data groups are recognised and linked through detected relationships', () => {
  const { tables, mapping } = load();
  const entityOf = (name: string) => mapping.tables[tableKey(tables.find(table => table.name === name)!)].entity;
  assert.deepEqual(['tb_forn', 'tb_cli', 'tb_centro_custo', 'tb_conta_bancaria', 'tb_categoria_financeira', 'tb_contas_pagar', 'tb_contas_receber', 'produtos'].map(entityOf),
    ['SUPPLIER', 'CUSTOMER', 'COST_CENTER', 'BANK_ACCOUNT', 'FIN_CATEGORY', 'PAYABLE', 'RECEIVABLE', 'PRODUCT']);
  const payable = mapping.tables[tableKey(tables.find(table => table.name === 'tb_contas_pagar')!)].columns;
  assert.deepEqual([payable.vl_pago.target, payable.dt_venc.target, payable.dt_pgto.target, payable.juros.target, payable.parcela.target, payable.situacao.target, payable.cod_cc.target, payable.cod_conta.target], ['paidAmount', 'dueAt', 'settledAt', 'interestAmount', 'installmentNumber', 'status', 'costCenterRef', 'bankAccountRef']);
  const links = mapping.relationships.map(relation => `${relation.from.table.split('::')[1]}.${relation.from.column}>${relation.to.table.split('::')[1]}`);
  for (const expected of ['tb_contas_pagar.cod_forn>tb_forn', 'tb_contas_pagar.cod_cat>tb_categoria_financeira', 'tb_contas_pagar.cod_cc>tb_centro_custo', 'tb_contas_pagar.cod_conta>tb_conta_bancaria', 'tb_contas_receber.cod_cli>tb_cli', 'produtos.cod_forn>tb_forn', 'tb_categoria_financeira.cod_pai>tb_categoria_financeira'])
    assert.ok(links.includes(expected), `relationship ${expected}`);
});

test('cadastral data: CEP/UF repaired, WhatsApp used only when the phone is missing, suppliers keep commercial data', () => {
  const { tables, mapping } = load();
  const { records } = stageTablesDetailed(tables, mapping, empty, today);
  const ana = named(records, 'CUSTOMER', 'name', 'Ana Souza');
  assert.equal(ana.status, 'VALID'); assert.equal(ana.normalized.phone, '11912345678'); assert.equal(ana.normalized.whatsapp, '11912345678');
  assert.ok(ana.corrections.some(correction => correction.rule === 'whatsapp_as_phone'));
  assert.equal(ana.normalized.zip, '01310100'); assert.equal(ana.normalized.state, 'SP'); assert.equal(ana.normalized.email, 'ana@x.com');
  const alfa = named(records, 'SUPPLIER', 'name', 'Distribuidora Alfa Ltda');
  assert.deepEqual([alfa.normalized.tradeName, alfa.normalized.document, alfa.normalized.stateRegistration, alfa.normalized.zip, alfa.normalized.state, alfa.normalized.contactName, alfa.normalized.notes], ['Alfa Bebidas', '11222333000181', '123.456.789', '01310100', 'SP', 'Carlos', 'Prazo 30 dias']);
  assert.ok(alfa.corrections.some(correction => correction.rule === 'zip_digits'), 'lost leading zero of the CEP restored');
  assert.equal(named(records, 'SUPPLIER', 'name', 'Hortifruti Beta ME').normalized.state, 'SP', 'state name converted to UF');
  assert.equal(records.filter(record => record.entity === 'CUSTOMER').every(record => record.normalized.marketingConsent === undefined), true);
});

test('products: supplier link, sub-category tree (parents first), cost, margin check and opening stock fields', () => {
  const { tables, mapping } = load();
  const { records } = stageTablesDetailed(tables, mapping, empty, today);
  const beer = named(records, 'PRODUCT', 'name', 'Cerveja Lata 350ml');
  assert.equal(beer.status, 'VALID');
  assert.deepEqual([beer.normalized.cost, beer.normalized.supplierName, beer.normalized.categoryName, beer.normalized.subcategoryName, beer.normalized.stockQuantity, beer.normalized.stockMin], ['3.2', 'Distribuidora Alfa Ltda', 'Bebidas', 'Cervejas', '120', '24']);
  const categories = records.filter(record => record.entity === 'CATEGORY');
  const beers = categories.find(record => record.normalized.name === 'Cervejas')!; const drinks = categories.find(record => record.normalized.name === 'Bebidas')!;
  assert.equal(beers.normalized.parentName, 'Bebidas'); assert.equal(beers.seq, 1); assert.equal(drinks.seq, 0);
  const margin = evaluateFields('PRODUCT', { name: 'Teste', price: '10,00', cost: '8,00', margin: '50' });
  assert.ok(margin.issues.some(issue => issue.code === 'margin_mismatch' && issue.severity === 'info'), 'a margin that contradicts price and cost is reported, never stored');
});

test('financial structure: typed categories with parents, cost centres and bank accounts with signed opening balances', () => {
  const { tables, mapping } = load();
  const { records } = stageTablesDetailed(tables, mapping, empty, today);
  const bebidas = named(records, 'FIN_CATEGORY', 'name', 'Bebidas');
  assert.deepEqual([bebidas.normalized.type, bebidas.normalized.parentName, bebidas.seq], ['EXPENSE', 'Insumos', 1]);
  assert.equal(named(records, 'FIN_CATEGORY', 'name', 'Vendas Salão').normalized.type, 'INCOME');
  const savings = named(records, 'BANK_ACCOUNT', 'name', 'Poupança Reserva');
  assert.deepEqual([savings.normalized.initialBalance, savings.normalized.initialBalanceAt, savings.status], ['-250.5', '2024-01-01', 'VALID']);
  assert.equal(named(records, 'BANK_ACCOUNT', 'name', 'Caixa Itaú').normalized.initialBalance, '10500');
});

test('payables keep historical dates and values; paid, partial, open, cancelled, installments and interest are classified without inventing payments', () => {
  const { tables, mapping } = load();
  const { records } = stageTablesDetailed(tables, mapping, empty, today);
  const payables = records.filter(record => record.entity === 'PAYABLE');
  const [paid, partial, open, rent, noDate, noAmount, cancelled, duplicate, orphan, badValue, badDate] = payables;
  assert.deepEqual([paid.status, paid.normalized.status, paid.normalized.paidAmount, paid.normalized.settledAt, paid.normalized.dueAt, paid.normalized.issuedAt], ['VALID', 'PAID', '1000.00', '2024-02-09', '2024-02-10', '2024-01-10'], 'historical dates are preserved, never replaced by today');
  assert.deepEqual([paid.normalized.installmentNumber, paid.normalized.installmentCount, paid.normalized.documentNumber, paid.normalized.supplierName, paid.normalized.costCenterName, paid.normalized.bankAccountName, paid.normalized.paymentMethod], ['1', '3', 'NF-1001', 'Distribuidora Alfa Ltda', 'Cozinha', 'Caixa Itaú', 'Boleto']);
  assert.deepEqual([partial.normalized.status, partial.normalized.paidAmount, partial.normalized.settledAt], ['OPEN', '400.00', null], 'partially paid stays open with the amount actually paid');
  assert.match(String(partial.normalized.notes), /Último pagamento parcial em 11\/03\/2024/);
  assert.deepEqual([open.normalized.status, open.normalized.paidAmount, open.normalized.settledAt], ['OPEN', '0.00', null], 'no payment is fabricated for an open instalment');
  assert.deepEqual([rent.status, rent.normalized.interestAmount, rent.normalized.paidAmount], ['VALID', '100', '5100.00'], 'interest explains the paid amount');
  assert.equal(noDate.status, 'REJECTED'); assert.ok(noDate.issues.some(issue => issue.code === 'paid_without_date'));
  assert.equal(noAmount.status, 'DIVERGENT'); assert.ok(noAmount.issues.some(issue => issue.code === 'paid_without_amount'));
  assert.ok(noAmount.corrections.some(correction => correction.rule === 'paid_assumed_full'), 'the assumption is recorded and needs approval');
  assert.deepEqual([cancelled.normalized.status, cancelled.status], ['CANCELLED', 'VALID']);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(orphan.status, 'DIVERGENT'); assert.ok(orphan.issues.some(issue => issue.code === 'unresolved_reference'));
  assert.equal(badValue.status, 'REJECTED'); assert.equal(badValue.original.valor, 'abc', 'original preserved');
  assert.equal(badDate.status, 'DIVERGENT'); assert.ok(badDate.issues.some(issue => issue.code === 'invalid_date'));
});

test('receivables: customer resolved through the relation (phone/document), instalments "1/2" split, received vs open', () => {
  const { tables, mapping } = load();
  const { records, stats } = stageTablesDetailed(tables, mapping, empty, today);
  const [first, second, third] = records.filter(record => record.entity === 'RECEIVABLE');
  assert.deepEqual([first.normalized.installmentNumber, first.normalized.installmentCount, first.normalized.customerName, first.normalized.customerPhone, first.normalized.status], ['1', '2', 'Ana Souza', '11912345678', 'PAID']);
  assert.ok(first.corrections.some(correction => correction.rule === 'installment_split'));
  assert.deepEqual([second.normalized.status, second.normalized.paidAmount, second.normalized.dueAt], ['OPEN', '0.00', '2024-03-15']);
  assert.deepEqual([third.normalized.customerName, third.normalized.status, third.normalized.settledAt], ['Empresa Gama', 'PAID', '2024-02-21']);
  assert.equal(stats.refs['RECEIVABLE.customerRef'].resolved, 3); assert.equal(stats.refs['PAYABLE.supplierRef'].unresolved, 1);
});

test('already existing entries, parties and categories are never duplicated; the restaurant spelling wins', () => {
  const { tables, mapping } = load();
  const existing: ExistingData = { ...empty, suppliers: [{ name: 'Distribuidora Alfa Ltda', document: '11222333000181' }], finCategories: [{ type: 'EXPENSE', name: 'aluguel' }],
    entries: [{ type: 'INCOME', documentNumber: 'F-1', description: 'Fiado Ana', dueAt: '2024-02-15', amount: '50.00', installmentNumber: 1, party: 'Ana Souza' }] };
  const { records } = stageTablesDetailed(tables, mapping, existing, today);
  assert.equal(named(records, 'SUPPLIER', 'name', 'Distribuidora Alfa Ltda').status, 'DUPLICATE');
  assert.equal(records.filter(record => record.entity === 'RECEIVABLE')[0].status, 'DUPLICATE', 'same document + instalment + party');
  assert.equal(records.filter(record => record.entity === 'RECEIVABLE')[1].status, 'VALID', 'the second instalment is a different entry');
  assert.equal(records.filter(record => record.entity === 'PAYABLE')[3].normalized.categoryName, 'aluguel');
});

test('instalment groups with missing parcels are reported, not invented; day>12 proves the date order', () => {
  const csv = 'descricao;fornecedor;documento;parcela;valor;vencimento;situacao\nFrete;Alfa;NF-9;1/3;10,00;13/03/2025;Aberto\nFrete;Alfa;NF-9;3/3;10,00;13/05/2025;Aberto\n';
  const { tables } = readSource('contas_pagar.csv', Buffer.from(csv));
  const { mapping } = suggestMapping(tables); for (const table of Object.values(mapping.tables)) table.approved = true;
  const { records, stats } = stageTablesDetailed(tables, mapping, empty, today);
  assert.equal(mapping.tables[tableKey(tables[0])].entity, 'PAYABLE');
  assert.equal(stats.installments.incomplete, 1); assert.ok(stats.alerts.some(alert => /faltam as parcelas 2 de 3/.test(alert)));
  assert.deepEqual(detectDateOrder(['03/25/2025', '04/01/2025']), { order: 'mdy', certain: true });
  assert.deepEqual(detectDateOrder(['13/03/2025', '04/01/2025']), { order: 'dmy', certain: true });
  assert.equal(detectDateOrder(['05/03/2025', '04/01/2025']).certain, false);
  assert.equal(parseDateValue('03/25/2025', 'mdy')?.iso, '2025-03-25'); assert.equal(parseDateValue('31/02/2025'), null);
});

test('status and consistency rules: contradictions are held for a human, never silently resolved', () => {
  const base = { description: 'Teste', amount: '100,00', dueAt: '10/02/2024' };
  const run = (extra: Record<string, string | null>) => evaluateFields('PAYABLE', { ...base, ...extra }, {}, { today });
  const codes = (extra: Record<string, string | null>) => run(extra).issues.map(issue => issue.code);
  assert.ok(codes({ status: 'Pago', settledAt: '11/02/2024', paidAmount: '120,00' }).includes('overpaid'));
  assert.ok(codes({ status: 'Pago', settledAt: '11/02/2024', paidAmount: '80,00' }).includes('paid_less_than_due'));
  assert.ok(codes({ status: 'Pago', settledAt: '11/02/2030', paidAmount: '100,00' }).includes('future_settlement'));
  assert.ok(codes({ status: 'Em aberto', paidAmount: '100,00' }).includes('open_but_paid'));
  assert.ok(codes({ status: 'Parcial', paidAmount: '100,00' }).includes('partial_inconsistent'));
  assert.ok(codes({ status: 'Cancelado', paidAmount: '10,00' }).includes('cancelled_with_payment'));
  assert.ok(codes({ status: 'quitadíssimo' }).includes('unknown_status'));
  assert.ok(codes({ paidAmount: '100,00' }).includes('status_unclear'), 'payment without status and without date cannot be deduced');
  assert.ok(codes({ parcela: null, installmentNumber: '4', installmentCount: '3' }).includes('installment_order'));
  const inferred = run({ paidAmount: '100,00', settledAt: '11/02/2024' });
  assert.equal(inferred.normalized.status, 'PAID'); assert.ok(inferred.corrections.some(correction => correction.rule === 'status_inferred'));
  assert.equal(run({ amount: '0,00' }).issues.find(issue => issue.code === 'zero_amount')?.severity, 'error');
  const mixed = evaluateFields('PAYABLE', { ...base, status: 'Vencido' }, {}, { today });
  assert.equal(mixed.normalized.status, 'OPEN'); assert.ok(mixed.corrections.some(correction => /calcula o atraso/.test(correction.reason)));
});

test('financial totals separate payables, receivables and opening balances', () => {
  const { tables, mapping } = load();
  const { records } = stageTablesDetailed(tables, mapping, empty, today);
  const totals = financialTotals(records.filter(record => record.approved), today);
  assert.equal(totals.receivable.count, 3); assert.equal(totals.receivable.amount, '2100.00'); assert.equal(totals.receivable.paid, '2050.00'); assert.equal(totals.receivable.open, '50.00'); assert.equal(totals.receivable.byStatus.paid, 2);
  assert.equal(totals.payable.count, 5, 'only approved: instalments 1-3, rent and the cancelled purchase');
  assert.deepEqual([totals.payable.byStatus.paid, totals.payable.byStatus.partial, totals.payable.byStatus.open, totals.payable.byStatus.cancelled], [2, 1, 1, 1]);
  assert.equal(totals.payable.overdue, 2, 'open and partial instalments past their due date');
  assert.deepEqual(totals.initialBalances, { accounts: 2, total: '10249.50' });
});

test('helpers: statuses, instalments, CEP and UF', () => {
  assert.deepEqual(parseEntryStatus('Parcialmente pago'), { status: 'PARTIAL', overdueWord: false }); assert.equal(parseEntryStatus('talvez'), null);
  assert.deepEqual(parseInstallment('2/5'), { number: 2, count: 5 }); assert.equal(parseInstallment('abc'), null);
  assert.equal((normalizeZip('1310100') as { value: string }).value, '01310100'); assert.equal(normalizeZip('123').ok, false);
  assert.equal((normalizeState('Minas Gerais') as { value: string }).value, 'MG'); assert.equal(normalizeState('XX').ok, false);
});
