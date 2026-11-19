// The real RM Restaurant destination model, as seen by the migration engine. Only fields that exist in packages/db/prisma/schema.prisma
// and can be written safely by the importer are listed; system-controlled columns (ids, tenantId, timestamps, qrToken, loyaltyPoints...) are deliberately absent.

export type FieldKind = 'text' | 'money' | 'balance' | 'quantity' | 'document' | 'phone' | 'email' | 'boolean' | 'unit' | 'barcode' | 'code' | 'ncm' | 'int' | 'date' | 'zip' | 'state' | 'percent' | 'finType' | 'entryStatus' | 'installment' | 'ref';
export type EntityKey = 'CATEGORY' | 'PRODUCT' | 'CUSTOMER' | 'SUPPLIER' | 'FIN_CATEGORY' | 'COST_CENTER' | 'BANK_ACCOUNT' | 'PAYABLE' | 'RECEIVABLE' | 'EMPLOYEE' | 'SALE' | 'SALE_ITEM';
export type GroupKey = 'products' | 'customers' | 'suppliers' | 'payables' | 'receivables' | 'finance' | 'employees' | 'sales';
export type TargetField = { key: string; label: string; kind: FieldKind; required?: boolean; aliases: string[]; max?: number; ref?: EntityKey };
export type EntityDefinition = { key: EntityKey; label: string; group: GroupKey; tableHints: string[]; fields: TargetField[]; order: number; keyFields: string[]; signature?: string[]; party?: string; alternatives?: Record<string, string[]> };

export const GROUPS: { key: GroupKey; label: string; icon: string; entities: EntityKey[] }[] = [
  { key: 'products', label: 'Produtos e estoque', icon: '📦', entities: ['CATEGORY', 'PRODUCT'] },
  { key: 'customers', label: 'Clientes', icon: '👥', entities: ['CUSTOMER'] },
  { key: 'suppliers', label: 'Fornecedores', icon: '🚚', entities: ['SUPPLIER'] },
  { key: 'payables', label: 'Contas a pagar', icon: '📤', entities: ['PAYABLE'] },
  { key: 'receivables', label: 'Contas a receber', icon: '📥', entities: ['RECEIVABLE'] },
  { key: 'finance', label: 'Estrutura financeira', icon: '🏦', entities: ['FIN_CATEGORY', 'COST_CENTER', 'BANK_ACCOUNT'] },
  { key: 'employees', label: 'Funcionários (cadastro)', icon: '🧑‍🍳', entities: ['EMPLOYEE'] },
  { key: 'sales', label: 'Histórico de vendas', icon: '🧾', entities: ['SALE', 'SALE_ITEM'] },
];

const entryFields = (party: 'supplierRef' | 'customerRef'): TargetField[] => [
  { key: 'description', label: 'Descrição do lançamento', kind: 'text', required: true, max: 200, aliases: ['descricao', 'historico', 'descricao lancamento', 'lancamento', 'titulo', 'description', 'memo', 'descricao titulo', 'historico lancamento'] },
  party === 'supplierRef'
    ? { key: 'supplierRef', label: 'Fornecedor', kind: 'ref', ref: 'SUPPLIER', aliases: ['fornecedor', 'nome fornecedor', 'id fornecedor', 'cod fornecedor', 'supplier', 'vendor', 'razao social', 'favorecido', 'credor', 'beneficiario'] }
    : { key: 'customerRef', label: 'Cliente', kind: 'ref', ref: 'CUSTOMER', aliases: ['cliente', 'nome cliente', 'id cliente', 'cod cliente', 'customer', 'sacado', 'devedor', 'pagador'] },
  { key: 'documentNumber', label: 'Número do documento', kind: 'code', max: 60, aliases: ['numero documento', 'documento', 'nf', 'nota fiscal', 'n documento', 'num doc', 'nr documento', 'duplicata', 'numero titulo', 'document number', 'nosso numero', 'doc'] },
  { key: 'installmentNumber', label: 'Número da parcela', kind: 'installment', aliases: ['parcela', 'numero parcela', 'n parcela', 'nr parcela', 'installment', 'num parcela', 'parc', 'parcela atual'] },
  { key: 'installmentCount', label: 'Quantidade de parcelas', kind: 'int', aliases: ['total parcelas', 'quantidade parcelas', 'qtd parcelas', 'numero parcelas', 'parcelas', 'installments', 'qtde parcelas', 'total de parcelas'] },
  { key: 'amount', label: 'Valor original', kind: 'money', required: true, aliases: ['valor', 'valor original', 'valor titulo', 'valor parcela', 'valor documento', 'amount', 'total', 'valor bruto', 'vl titulo', 'vlr original', 'valor lancamento', 'valor nominal'] },
  { key: 'paidAmount', label: party === 'supplierRef' ? 'Valor pago' : 'Valor recebido', kind: 'money', aliases: ['valor pago', 'valor recebido', 'pago', 'recebido', 'valor baixa', 'vl pago', 'paid amount', 'valor liquidado', 'vlr pago', 'vlr recebido', 'valor quitado'] },
  { key: 'interestAmount', label: 'Juros e multa', kind: 'money', aliases: ['juros', 'multa', 'juros multa', 'interest', 'acrescimo', 'mora', 'juros mora'] },
  { key: 'discountAmount', label: 'Desconto', kind: 'money', aliases: ['desconto', 'discount', 'abatimento'] },
  { key: 'issuedAt', label: 'Data de emissão', kind: 'date', aliases: ['emissao', 'data emissao', 'dt emissao', 'issue date', 'data lancamento', 'data competencia', 'data documento', 'data cadastro lancamento'] },
  { key: 'dueAt', label: 'Data de vencimento', kind: 'date', aliases: ['vencimento', 'data vencimento', 'dt vencimento', 'due date', 'vcto', 'data venc', 'dt venc', 'venc'] },
  { key: 'settledAt', label: party === 'supplierRef' ? 'Data de pagamento' : 'Data de recebimento', kind: 'date', aliases: ['pagamento', 'data pagamento', 'dt pagamento', 'data baixa', 'data recebimento', 'dt recebimento', 'baixa', 'payment date', 'data liquidacao', 'liquidacao', 'recebimento', 'data quitacao', 'dt baixa'] },
  { key: 'categoryRef', label: 'Categoria financeira', kind: 'ref', ref: 'FIN_CATEGORY', aliases: ['categoria', 'categoria financeira', 'plano contas', 'conta contabil', 'classificacao', 'natureza', 'category', 'tipo despesa', 'tipo receita', 'categoria despesa', 'categoria receita', 'id categoria', 'cod categoria'] },
  { key: 'subcategoryRef', label: 'Subcategoria financeira', kind: 'ref', ref: 'FIN_CATEGORY', aliases: ['subcategoria', 'sub categoria', 'subclassificacao', 'subcategory', 'sub grupo'] },
  { key: 'costCenterRef', label: 'Centro de custo', kind: 'ref', ref: 'COST_CENTER', aliases: ['centro custo', 'centro de custo', 'centro', 'cost center', 'id centro custo', 'cod centro custo', 'ccusto', 'cc', 'cod cc', 'id cc'] },
  { key: 'bankAccountRef', label: 'Conta bancária', kind: 'ref', ref: 'BANK_ACCOUNT', aliases: ['conta bancaria', 'banco', 'conta corrente', 'bank account', 'id conta', 'cod conta', 'conta financeira', 'caixa', 'conta'] },
  { key: 'paymentMethod', label: party === 'supplierRef' ? 'Forma de pagamento' : 'Forma de recebimento', kind: 'text', max: 60, aliases: ['forma pagamento', 'forma recebimento', 'forma', 'meio pagamento', 'payment method', 'tipo pagamento', 'especie', 'forma de pagamento'] },
  { key: 'status', label: 'Situação do lançamento', kind: 'entryStatus', aliases: ['situacao', 'status', 'estado', 'situacao titulo', 'situacao lancamento', 'quitado', 'baixado'] },
  { key: 'notes', label: 'Observações', kind: 'text', max: 1000, aliases: ['observacao', 'obs', 'observacoes', 'notes', 'anotacoes'] },
];

const address = (): TargetField[] => [
  { key: 'address', label: 'Endereço', kind: 'text', max: 400, aliases: ['endereco', 'address', 'logradouro', 'rua', 'endereco completo'] },
  { key: 'zip', label: 'CEP', kind: 'zip', aliases: ['cep', 'zip', 'codigo postal', 'zipcode'] },
  { key: 'city', label: 'Cidade', kind: 'text', max: 100, aliases: ['cidade', 'city', 'municipio'] },
  { key: 'state', label: 'Estado (UF)', kind: 'state', aliases: ['estado', 'uf', 'state', 'sigla estado'] },
];

export const ENTITIES: Record<EntityKey, EntityDefinition> = {
  CATEGORY: {
    key: 'CATEGORY', label: 'Categorias de produtos', group: 'products', order: 1, keyFields: ['name'],
    tableHints: ['categoria', 'categorias', 'category', 'categories', 'grupo', 'grupos', 'group', 'secao', 'departamento', 'familia', 'subgrupo'],
    fields: [
      { key: 'name', label: 'Nome da categoria', kind: 'text', required: true, max: 100, aliases: ['nome', 'descricao', 'nome categoria', 'categoria', 'grupo', 'nome grupo', 'description', 'name', 'category name', 'titulo'] },
      { key: 'parentRef', label: 'Categoria superior', kind: 'ref', ref: 'CATEGORY', aliases: ['categoria pai', 'pai', 'parent', 'grupo pai', 'id pai', 'cod pai', 'categoria superior', 'grupo superior'] },
    ],
  },
  PRODUCT: {
    key: 'PRODUCT', label: 'Produtos', group: 'products', order: 7, keyFields: ['code', 'barcode', 'name'],
    tableHints: ['produto', 'produtos', 'product', 'products', 'item', 'itens', 'items', 'cardapio', 'menu', 'prato', 'pratos', 'mercadoria', 'mercadorias', 'artigo', 'artigos'],
    fields: [
      { key: 'name', label: 'Nome do produto', kind: 'text', required: true, max: 160, aliases: ['nome produto', 'nome', 'descricao item', 'descricao produto', 'descricao', 'item', 'produto', 'product name', 'name', 'title', 'titulo', 'nome item', 'denominacao'] },
      { key: 'price', label: 'Preço de venda', kind: 'money', required: true, aliases: ['preco', 'preco venda', 'valor venda', 'valor unitario', 'valor', 'price', 'sale price', 'unit price', 'pvenda', 'preco unitario', 'vl venda', 'pv'] },
      { key: 'code', label: 'Código interno', kind: 'code', max: 50, aliases: ['codigo', 'cod', 'sku', 'referencia', 'ref', 'codigo interno', 'codigo produto', 'code', 'cod produto'] },
      { key: 'barcode', label: 'Código de barras', kind: 'barcode', max: 40, aliases: ['codigo barras', 'cod barras', 'ean', 'gtin', 'barcode', 'ean13', 'codbarras', 'codigo ean'] },
      { key: 'description', label: 'Descrição', kind: 'text', max: 2000, aliases: ['descricao longa', 'detalhes', 'observacao', 'ingredientes', 'description', 'descricao detalhada', 'complemento'] },
      { key: 'cost', label: 'Preço de custo', kind: 'money', aliases: ['custo', 'preco custo', 'valor custo', 'cost', 'vl custo', 'custo medio', 'preco compra'] },
      { key: 'margin', label: 'Margem (%)', kind: 'percent', aliases: ['margem', 'margem lucro', 'margem percentual', 'markup', 'margin', 'margem de lucro'] },
      { key: 'categoryRef', label: 'Categoria', kind: 'ref', ref: 'CATEGORY', aliases: ['categoria', 'grupo', 'grupo produto', 'category', 'secao', 'departamento', 'familia', 'id categoria', 'cod categoria', 'id grupo', 'cod grupo', 'tipo'] },
      { key: 'subcategoryRef', label: 'Subcategoria', kind: 'ref', ref: 'CATEGORY', aliases: ['subcategoria', 'subgrupo', 'sub grupo', 'subcategory', 'sub categoria', 'id subgrupo', 'cod subgrupo'] },
      { key: 'supplierRef', label: 'Fornecedor vinculado', kind: 'ref', ref: 'SUPPLIER', aliases: ['fornecedor', 'fornecedor principal', 'supplier', 'id fornecedor', 'cod fornecedor', 'vendor'] },
      { key: 'measureUnit', label: 'Unidade de medida', kind: 'unit', aliases: ['unidade', 'un', 'und', 'unidade medida', 'unit', 'um', 'medida'] },
      { key: 'stockQuantity', label: 'Estoque atual (saldo inicial)', kind: 'quantity', aliases: ['estoque', 'saldo', 'estoque atual', 'quantidade', 'qtd', 'stock', 'quantity', 'saldo atual', 'qtde estoque'] },
      { key: 'stockMin', label: 'Estoque mínimo', kind: 'quantity', aliases: ['estoque minimo', 'minimo', 'min stock', 'estoque min', 'qtd minima'] },
      { key: 'ncm', label: 'NCM', kind: 'ncm', aliases: ['ncm', 'classificacao fiscal'] },
      { key: 'prepTimeMinutes', label: 'Tempo de preparo (min)', kind: 'int', aliases: ['tempo preparo', 'prep time', 'tempo producao', 'minutos preparo'] },
      { key: 'active', label: 'Ativo', kind: 'boolean', aliases: ['ativo', 'situacao', 'status', 'active', 'inativo', 'habilitado', 'disponivel', 'ativa'] },
    ],
  },
  CUSTOMER: {
    key: 'CUSTOMER', label: 'Clientes', group: 'customers', order: 6, keyFields: ['phone', 'document'], alternatives: { phone: ['whatsapp'] },
    tableHints: ['cliente', 'clientes', 'customer', 'customers', 'consumidor', 'consumidores', 'contato', 'contatos', 'pessoa', 'pessoas', 'client', 'clients'],
    fields: [
      { key: 'name', label: 'Nome / razão social', kind: 'text', required: true, max: 160, aliases: ['nome cliente', 'cli nome', 'customer name', 'nome', 'razao social', 'name', 'cliente', 'nome completo', 'full name'] },
      { key: 'phone', label: 'Telefone', kind: 'phone', required: true, aliases: ['telefone', 'fone', 'celular', 'phone', 'tel', 'contato', 'telefone celular', 'cel', 'mobile', 'telefone fixo'] },
      { key: 'whatsapp', label: 'WhatsApp', kind: 'phone', aliases: ['whatsapp', 'whats', 'zap', 'whatsapp celular', 'telefone whatsapp'] },
      { key: 'document', label: 'CPF/CNPJ', kind: 'document', aliases: ['cpf', 'cnpj', 'documento', 'cpf cnpj', 'cli cpf', 'document', 'doc', 'cpfcnpj', 'tax id'] },
      { key: 'email', label: 'E-mail', kind: 'email', aliases: ['email', 'e mail', 'mail', 'correio'] },
      ...address(),
      { key: 'notes', label: 'Observações', kind: 'text', max: 1000, aliases: ['observacao', 'observacoes', 'obs', 'notes', 'anotacoes'] },
      { key: 'active', label: 'Ativo', kind: 'boolean', aliases: ['ativo', 'situacao', 'status', 'active', 'inativo', 'ativa'] },
    ],
  },
  SUPPLIER: {
    key: 'SUPPLIER', label: 'Fornecedores', group: 'suppliers', order: 5, keyFields: ['document', 'name'],
    tableHints: ['fornecedor', 'fornecedores', 'supplier', 'suppliers', 'vendor', 'vendors'],
    fields: [
      { key: 'name', label: 'Razão social', kind: 'text', required: true, max: 160, aliases: ['nome fornecedor', 'razao social', 'fornecedor', 'supplier name', 'nome', 'name', 'vendor'] },
      { key: 'tradeName', label: 'Nome fantasia', kind: 'text', max: 160, aliases: ['nome fantasia', 'fantasia', 'trade name', 'nome comercial'] },
      { key: 'document', label: 'CNPJ/CPF', kind: 'document', aliases: ['cnpj', 'cpf', 'documento', 'cpf cnpj', 'document', 'doc', 'cnpj cpf'] },
      { key: 'stateRegistration', label: 'Inscrição estadual', kind: 'code', max: 30, aliases: ['inscricao estadual', 'ie', 'insc estadual', 'state registration', 'inscr estadual'] },
      { key: 'phone', label: 'Telefone', kind: 'phone', aliases: ['telefone', 'fone', 'celular', 'phone', 'tel'] },
      { key: 'email', label: 'E-mail', kind: 'email', aliases: ['email', 'e mail', 'mail'] },
      ...address(),
      { key: 'contactName', label: 'Contato', kind: 'text', max: 160, aliases: ['contato', 'nome contato', 'responsavel', 'representante', 'contact', 'vendedor'] },
      { key: 'notes', label: 'Dados comerciais / observações', kind: 'text', max: 1000, aliases: ['observacao', 'observacoes', 'obs', 'dados comerciais', 'condicoes pagamento', 'prazo pagamento', 'notes'] },
      { key: 'active', label: 'Ativo', kind: 'boolean', aliases: ['ativo', 'situacao', 'status', 'active', 'inativo'] },
    ],
  },
  FIN_CATEGORY: {
    key: 'FIN_CATEGORY', label: 'Categorias financeiras', group: 'finance', order: 2, keyFields: ['type', 'name'],
    tableHints: ['categoria financeira', 'categorias financeiras', 'plano contas', 'plano de contas', 'classificacao financeira', 'natureza financeira', 'financial category', 'categoria despesa', 'categoria receita', 'categorias despesas', 'categorias receitas', 'natureza'],
    fields: [
      { key: 'name', label: 'Nome da categoria', kind: 'text', required: true, max: 100, aliases: ['nome', 'descricao', 'categoria', 'nome categoria', 'name', 'description', 'conta'] },
      { key: 'type', label: 'Receita / despesa', kind: 'finType', required: true, aliases: ['tipo', 'natureza', 'classificacao', 'type', 'receita despesa', 'tipo conta', 'tipo categoria', 'direcao'] },
      { key: 'parentRef', label: 'Categoria superior', kind: 'ref', ref: 'FIN_CATEGORY', aliases: ['categoria pai', 'pai', 'parent', 'id pai', 'cod pai', 'categoria superior', 'conta pai', 'conta superior'] },
    ],
  },
  COST_CENTER: {
    key: 'COST_CENTER', label: 'Centros de custo', group: 'finance', order: 3, keyFields: ['name'],
    tableHints: ['centro custo', 'centros custo', 'centro de custo', 'centros de custo', 'cost center', 'cost centers', 'ccusto'],
    fields: [
      { key: 'name', label: 'Nome do centro de custo', kind: 'text', required: true, max: 100, aliases: ['nome', 'descricao', 'centro custo', 'centro de custo', 'name', 'description'] },
      { key: 'code', label: 'Código', kind: 'code', max: 30, aliases: ['codigo', 'cod', 'code', 'sigla'] },
      { key: 'active', label: 'Ativo', kind: 'boolean', aliases: ['ativo', 'situacao', 'status', 'active', 'inativo'] },
    ],
  },
  BANK_ACCOUNT: {
    key: 'BANK_ACCOUNT', label: 'Contas bancárias e saldos iniciais', group: 'finance', order: 4, keyFields: ['name'],
    tableHints: ['conta bancaria', 'contas bancarias', 'banco', 'bancos', 'bank account', 'bank accounts', 'conta corrente', 'contas correntes', 'conta financeira', 'contas financeiras', 'caixa', 'caixas'],
    fields: [
      { key: 'name', label: 'Nome da conta', kind: 'text', required: true, max: 100, aliases: ['nome', 'nome conta', 'conta', 'conta bancaria', 'descricao', 'apelido', 'name', 'titular'] },
      { key: 'bank', label: 'Banco', kind: 'text', max: 100, aliases: ['banco', 'nome banco', 'bank', 'instituicao'] },
      { key: 'agency', label: 'Agência', kind: 'code', max: 20, aliases: ['agencia', 'ag', 'agency'] },
      { key: 'accountNumber', label: 'Número da conta', kind: 'code', max: 30, aliases: ['numero conta', 'conta corrente', 'cc', 'account number', 'n conta', 'num conta', 'nr conta'] },
      { key: 'initialBalance', label: 'Saldo inicial', kind: 'balance', aliases: ['saldo inicial', 'saldo', 'saldo abertura', 'initial balance', 'saldo atual', 'saldo de abertura'] },
      { key: 'initialBalanceAt', label: 'Data do saldo inicial', kind: 'date', aliases: ['data saldo', 'data saldo inicial', 'data abertura', 'data do saldo', 'balance date', 'data de abertura'] },
      { key: 'active', label: 'Ativa', kind: 'boolean', aliases: ['ativo', 'ativa', 'situacao', 'status', 'active', 'inativo'] },
    ],
  },
  EMPLOYEE: {
    key: 'EMPLOYEE', label: 'Funcionários (cadastro, sem acesso ao sistema)', group: 'employees', order: 10, keyFields: ['cpf', 'fullName'],
    tableHints: ['funcionario', 'funcionarios', 'colaborador', 'colaboradores', 'employee', 'employees', 'staff', 'garcom', 'garcons', 'atendente', 'atendentes'],
    fields: [
      { key: 'fullName', label: 'Nome completo', kind: 'text', required: true, max: 160, aliases: ['nome', 'nome completo', 'nome funcionario', 'funcionario', 'colaborador', 'full name', 'name', 'employee'] },
      { key: 'cpf', label: 'CPF', kind: 'document', aliases: ['cpf', 'documento', 'doc', 'cpf funcionario'] },
      { key: 'phone', label: 'Telefone', kind: 'phone', aliases: ['telefone', 'fone', 'celular', 'phone', 'tel', 'whatsapp'] },
      { key: 'email', label: 'E-mail', kind: 'email', aliases: ['email', 'e mail', 'mail'] },
      { key: 'position', label: 'Cargo / função', kind: 'text', max: 100, aliases: ['cargo', 'funcao', 'função', 'position', 'role', 'ocupacao', 'setor'] },
      { key: 'admissionDate', label: 'Data de admissão', kind: 'date', aliases: ['admissao', 'data admissao', 'data de admissao', 'dt admissao', 'hire date', 'admission date', 'inicio'] },
      { key: 'active', label: 'Ativo', kind: 'boolean', aliases: ['ativo', 'situacao', 'status', 'active', 'inativo', 'demitido'] },
    ],
  },
  SALE: {
    key: 'SALE', label: 'Vendas históricas', group: 'sales', order: 11, keyFields: ['saleNumber'],
    tableHints: ['venda', 'vendas', 'pedido', 'pedidos', 'sale', 'sales', 'order', 'orders', 'cupom', 'cupons', 'comanda fechada', 'historico vendas'],
    signature: ['soldAt', 'total', 'saleNumber', 'paymentMethod'],
    fields: [
      { key: 'saleNumber', label: 'Número da venda na origem', kind: 'code', required: true, max: 50, aliases: ['numero venda', 'numero', 'num', 'codigo', 'cod', 'id', 'id venda', 'n pedido', 'numero pedido', 'pedido', 'venda', 'sale number', 'order number', 'cupom'] },
      { key: 'soldAt', label: 'Data da venda', kind: 'date', required: true, aliases: ['data', 'data venda', 'data pedido', 'dt venda', 'data emissao', 'emissao', 'sale date', 'order date', 'created at', 'data hora', 'data da venda'] },
      { key: 'total', label: 'Valor total', kind: 'money', required: true, aliases: ['total', 'valor total', 'valor', 'vl total', 'total venda', 'total pedido', 'amount', 'total amount', 'valor final'] },
      { key: 'discount', label: 'Desconto', kind: 'money', aliases: ['desconto', 'discount', 'vl desconto', 'desconto total'] },
      { key: 'serviceFee', label: 'Taxa de serviço', kind: 'money', aliases: ['taxa servico', 'servico', 'gorjeta', 'service fee', 'taxa de servico', '10%'] },
      { key: 'deliveryFee', label: 'Taxa de entrega', kind: 'money', aliases: ['taxa entrega', 'entrega', 'frete', 'delivery fee', 'taxa de entrega'] },
      { key: 'customerName', label: 'Cliente (nome)', kind: 'text', max: 160, aliases: ['cliente', 'nome cliente', 'customer', 'customer name', 'consumidor'] },
      { key: 'customerPhone', label: 'Cliente (telefone)', kind: 'phone', aliases: ['telefone cliente', 'fone cliente', 'celular cliente', 'customer phone', 'telefone'] },
      { key: 'paymentMethod', label: 'Forma de pagamento', kind: 'text', max: 60, aliases: ['forma pagamento', 'pagamento', 'forma', 'meio pagamento', 'payment method', 'payment', 'tipo pagamento'] },
      { key: 'status', label: 'Situação', kind: 'text', max: 40, aliases: ['situacao', 'status', 'estado', 'cancelado', 'situacao venda'] },
    ],
  },
  SALE_ITEM: {
    key: 'SALE_ITEM', label: 'Itens das vendas históricas', group: 'sales', order: 12, keyFields: ['saleNumber', 'productCode'],
    tableHints: ['item venda', 'itens venda', 'itens de venda', 'itens pedido', 'itens do pedido', 'item pedido', 'sale item', 'sale items', 'order items', 'order item', 'venda itens', 'pedido itens'],
    signature: ['saleNumber', 'quantity', 'unitPrice'],
    fields: [
      { key: 'saleNumber', label: 'Número da venda na origem', kind: 'code', required: true, max: 50, aliases: ['numero venda', 'venda', 'id venda', 'cod venda', 'pedido', 'id pedido', 'numero pedido', 'sale', 'sale id', 'order id', 'order number', 'cupom'] },
      { key: 'productCode', label: 'Código do produto', kind: 'code', max: 50, aliases: ['codigo produto', 'cod produto', 'produto codigo', 'sku', 'codigo', 'id produto', 'product code', 'product id', 'ean', 'codigo barras'] },
      { key: 'productName', label: 'Nome do produto', kind: 'text', max: 160, aliases: ['produto', 'nome produto', 'descricao', 'descricao produto', 'item', 'product', 'product name'] },
      { key: 'quantity', label: 'Quantidade', kind: 'quantity', required: true, aliases: ['quantidade', 'qtd', 'qtde', 'qty', 'quantity'] },
      { key: 'unitPrice', label: 'Preço unitário', kind: 'money', required: true, aliases: ['preco unitario', 'valor unitario', 'preco', 'vl unitario', 'unit price', 'price', 'valor'] },
      { key: 'total', label: 'Total do item', kind: 'money', aliases: ['total', 'valor total', 'total item', 'subtotal', 'vl total', 'line total'] },
    ],
  },
  PAYABLE: {
    key: 'PAYABLE', label: 'Contas a pagar', group: 'payables', order: 8, keyFields: ['documentNumber'], party: 'supplierRef', signature: ['dueAt', 'settledAt', 'paidAmount', 'installmentNumber', 'status', 'documentNumber'],
    tableHints: ['conta pagar', 'contas pagar', 'contas a pagar', 'conta a pagar', 'pagar', 'titulos pagar', 'titulos a pagar', 'payable', 'payables', 'accounts payable', 'despesa', 'despesas', 'lancamentos pagar', 'ap'],
    fields: entryFields('supplierRef'),
  },
  RECEIVABLE: {
    key: 'RECEIVABLE', label: 'Contas a receber', group: 'receivables', order: 9, keyFields: ['documentNumber'], party: 'customerRef', signature: ['dueAt', 'settledAt', 'paidAmount', 'installmentNumber', 'status', 'documentNumber'],
    tableHints: ['conta receber', 'contas receber', 'contas a receber', 'conta a receber', 'receber', 'titulos receber', 'titulos a receber', 'receivable', 'receivables', 'accounts receivable', 'receita', 'receitas', 'lancamentos receber', 'ar', 'crediario'],
    fields: entryFields('customerRef'),
  },
};

export const ENTITY_KEYS = Object.keys(ENTITIES) as EntityKey[];
export const fieldOf = (entity: EntityKey, key: string) => ENTITIES[entity].fields.find(field => field.key === key);
export const isFinancialEntry = (entity: string): entity is 'PAYABLE' | 'RECEIVABLE' => entity === 'PAYABLE' || entity === 'RECEIVABLE';
export const entryType = (entity: 'PAYABLE' | 'RECEIVABLE') => entity === 'PAYABLE' ? 'EXPENSE' as const : 'INCOME' as const;
// Reference fields are written as "<x>Name" in the staged values (categoryRef -> categoryName).
export const outputKey = (field: TargetField) => field.kind === 'ref' ? field.key.replace(/Ref$/, 'Name') : field.key;
export const fieldForOutputKey = (entity: EntityKey, key: string) => ENTITIES[entity].fields.find(field => outputKey(field) === key);

// Required fields still unmapped (a required field may be satisfied by an alternative one, e.g. WhatsApp standing in for the phone).
export function missingRequiredFields(entity: EntityKey, targets: string[]): string[] {
  const definition = ENTITIES[entity];
  return definition.fields.filter(field => field.required && !targets.includes(field.key) && !(definition.alternatives?.[field.key] ?? []).some(alt => targets.includes(alt))).map(field => field.key);
}

// Not migrated by this version (section 9 of the final scope); reported by /capabilities so nobody assumes these are covered.
export const UNSUPPORTED_MODULES = [
  'Documentos fiscais históricos (XML/protocolos da origem)', 'Mesas e comandas abertas', 'Usuários e senhas (acesso ao sistema é criado pelo fluxo seguro de convite do RM)', 'Fichas técnicas e adicionais/combos',
  'Histórico antigo de movimentações de estoque (apenas o saldo inicial é migrado)', 'Imagens e anexos', 'Caixa, terminais e turnos históricos',
];
