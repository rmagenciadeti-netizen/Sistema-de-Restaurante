export type ReportColumnType = 'text' | 'money' | 'number' | 'percent' | 'datetime';
export type ReportColumn = { key: string; label: string; type: ReportColumnType };
// Money values arrive as fixed strings, percent values as numbers from 0 to 100 and datetimes as ISO strings.
export type ReportTable = {
  kind: string;
  period: { from: string; to: string };
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  truncated?: boolean;
};
export type ReportCatalogItem = { kind: string; title: string; description: string; group: string };

// 'overview' and 'service-fee-distribution' are rendered locally from the older /reports endpoints; every other kind is GET /reports/x/:kind.
export const LOCAL_REPORTS = ['overview', 'service-fee-distribution'] as const;
export type ReportOption = { param: string; label: string; choices: { value: string; label: string }[] };

export const REPORT_CATALOG: ReportCatalogItem[] = [
  { kind: 'overview', title: 'Visão geral', description: 'Totais do período, recebimentos, mais vendidos e vendas por atendente.', group: 'Geral' },
  { kind: 'service-fee-distribution', title: 'Rateio da taxa de serviço', description: 'Parte do atendente e fundo a distribuir, por atendente.', group: 'Geral' },
  { kind: 'sales', title: 'Vendas', description: 'Pedidos do período, por pedido ou por dia.', group: 'Vendas' },
  { kind: 'service-fee', title: 'Taxa de serviço', description: 'Taxa de serviço cobrada por dia.', group: 'Vendas' },
  { kind: 'couvert', title: 'Couvert artístico', description: 'Couvert cobrado por dia e evento.', group: 'Vendas' },
  { kind: 'cancellations', title: 'Análise de cancelamentos', description: 'Pedidos cancelados, usuário e motivo quando informado.', group: 'Vendas' },
  { kind: 'scheduled-sales', title: 'Vendas agendadas', description: 'Pedidos agendados, liberação e situação.', group: 'Vendas' },
  { kind: 'product-classification', title: 'Classificação de produtos', description: 'Curva ABC por faturamento: A até 80%, B até 95% e C no restante.', group: 'Produtos' },
  { kind: 'products-sold', title: 'Produtos vendidos', description: 'Quantidade e faturamento por produto.', group: 'Produtos' },
  { kind: 'profit-margin', title: 'Margem de lucro dos produtos', description: 'Preço, custo e margem dos produtos vendidos. Produtos sem custo cadastrado ficam sem margem.', group: 'Produtos' },
  { kind: 'promoted-products', title: 'Produtos em promoção', description: 'Promoções vigentes e passadas e vendas com preço promocional.', group: 'Produtos' },
  { kind: 'availability', title: 'Controle de disponibilidade', description: 'Produtos ativos, inativos e sem estoque conforme a ficha técnica (não depende do período).', group: 'Produtos' },
  { kind: 'dre', title: 'DRE Simplificado', description: 'Receita, descontos, custo estimado, despesas pagas e resultado do período.', group: 'Financeiro' },
  { kind: 'sales-by-payment', title: 'Vendas por formas de pagamento', description: 'Pagamentos confirmados por forma de pagamento.', group: 'Financeiro' },
  { kind: 'payables', title: 'Contas a pagar', description: 'Despesas por vencimento e situação, com dias de atraso.', group: 'Financeiro' },
  { kind: 'receivables', title: 'Contas a receber', description: 'Receitas por vencimento e situação, com dias de atraso.', group: 'Financeiro' },
  { kind: 'cash-closings', title: 'Conferência de fechamentos', description: 'Caixa esperado, contado e diferença de cada fechamento.', group: 'Financeiro' },
  { kind: 'delivery-zones', title: 'Zonas de entrega', description: 'Pedidos e valores por zona de entrega.', group: 'Entrega e clientes' },
  { kind: 'loyal-customers', title: 'Clientes fiéis', description: 'Clientes por número de pedidos, total gasto e pontos.', group: 'Entrega e clientes' },
  { kind: 'bot-conversations', title: 'Atendimentos via robô', description: 'Mensagens de WhatsApp enviadas por dia e situação.', group: 'Entrega e clientes' },
];

export const REPORT_OPTIONS: Record<string, ReportOption> = {
  sales: { param: 'groupBy', label: 'Agrupar', choices: [{ value: '', label: 'Por pedido' }, { value: 'day', label: 'Por dia' }] },
  cancellations: { param: 'groupBy', label: 'Agrupar', choices: [{ value: '', label: 'Por pedido' }, { value: 'day', label: 'Por dia' }, { value: 'user', label: 'Por usuário' }] },
  payables: { param: 'status', label: 'Situação', choices: [{ value: '', label: 'Todas' }, { value: 'OPEN', label: 'Em aberto' }, { value: 'PAID', label: 'Pagas' }] },
  receivables: { param: 'status', label: 'Situação', choices: [{ value: '', label: 'Todas' }, { value: 'OPEN', label: 'Em aberto' }, { value: 'PAID', label: 'Recebidas' }] },
  availability: { param: 'status', label: 'Cadastro', choices: [{ value: '', label: 'Todos' }, { value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }] },
};
