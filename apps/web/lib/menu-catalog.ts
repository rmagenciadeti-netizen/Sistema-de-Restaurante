export type MenuItem = { href: string; label: string; icon: string; masterOnly?: boolean };
export type MenuGroup = { title: string; icon: string; items: MenuItem[] };

// Single source of truth for the sidebar, the "system personalization" editor and the dashboard shortcuts.
export const reportMenu: MenuItem[] = [
  { href: '/reports', label: 'Central de relatórios', icon: '📊' },
  { href: '/reports?r=sales', label: 'Vendas', icon: '🧾' },
  { href: '/reports?r=service-fee', label: 'Taxa de serviço', icon: '🧮' },
  { href: '/reports?r=couvert', label: 'Couvert artístico', icon: '🎤' },
  { href: '/reports?r=dre', label: 'DRE simplificado', icon: '📈' },
  { href: '/reports?r=cancellations', label: 'Análise de cancelamentos', icon: '🚫' },
  { href: '/reports?r=product-classification', label: 'Classificação de produtos', icon: '🏷️' },
  { href: '/reports?r=scheduled-sales', label: 'Vendas agendadas', icon: '⏰' },
  { href: '/reports?r=products-sold', label: 'Produtos vendidos', icon: '🍽️' },
  { href: '/reports?r=profit-margin', label: 'Margem de lucro dos produtos', icon: '💹' },
  { href: '/reports?r=sales-by-payment', label: 'Vendas por forma de pagamento', icon: '💳' },
  { href: '/reports?r=payables', label: 'Relatório de contas a pagar', icon: '📤' },
  { href: '/reports?r=receivables', label: 'Relatório de contas a receber', icon: '📥' },
  { href: '/reports?r=cash-closings', label: 'Conferência de fechamentos', icon: '🔍' },
  { href: '/reports?r=delivery-zones', label: 'Zonas de entrega', icon: '📍' },
  { href: '/reports?r=loyal-customers', label: 'Clientes fiéis', icon: '💛' },
  { href: '/reports?r=promoted-products', label: 'Produtos em promoção', icon: '🔖' },
  { href: '/reports?r=availability', label: 'Controle de disponibilidade', icon: '✅' },
  { href: '/reports?r=bot-conversations', label: 'Atendimentos via robô', icon: '🤖' },
];

export const menuGroups: MenuGroup[] = [
  { title: 'Início', icon: '🏠', items: [{ href: '/dashboard', label: 'Visão geral', icon: '🏠' }] },
  { title: 'Para seus clientes', icon: '🙂', items: [
    { href: '/store', label: 'Link da loja virtual', icon: '🔗' }, { href: '/customers', label: 'Cadastro de clientes', icon: '⭐' },
    { href: '/coupons', label: 'Cupons de desconto', icon: '🏷️' }, { href: '/tables', label: 'QR Code na mesa', icon: '▦' },
    { href: '/reservations', label: 'Reservas', icon: '📅' },
  ] },
  { title: 'Gerenciamento de produtos', icon: '📦', items: [
    { href: '/categories', label: 'Categorias', icon: '📋' }, { href: '/production', label: 'Setores de produção', icon: '🖨️' },
    { href: '/products', label: 'Produtos', icon: '🍔' }, { href: '/bulk-adjust', label: 'Ajuste em massa', icon: '🔄' },
    { href: '/category-hours', label: 'Exibição das categorias', icon: '🕘' }, { href: '/promotions', label: 'Promoções', icon: '🔖' },
    { href: '/scale-file', label: 'Arquivo para balança', icon: '⚖️' }, { href: '/catalog', label: 'Adicionais e combos', icon: '🧀' },
    { href: '/inventory', label: 'Estoque e fichas', icon: '📦' },
  ] },
  { title: 'Controle de entrega', icon: '🛵', items: [
    { href: '/couriers', label: 'Entregadores', icon: '🏍️' }, { href: '/settings?tab=fulfillment', label: 'Zonas não mapeadas', icon: '📍' },
    { href: '/delivery', label: 'Entregas e zonas mapeadas', icon: '🛵' },
  ] },
  { title: 'Gerenciamento financeiro', icon: '💵', items: [
    { href: '/payment-methods', label: 'Formas de pagamento', icon: '💶' }, { href: '/financial?type=EXPENSE', label: 'Contas a pagar', icon: '📤' },
    { href: '/financial?type=INCOME', label: 'Contas a receber', icon: '📥' }, { href: '/financial-categories?type=EXPENSE', label: 'Categorias (Contas a pagar)', icon: '🗂️' },
    { href: '/financial-categories?type=INCOME', label: 'Categorias (Contas a receber)', icon: '🗂️' }, { href: '/received-invoices', label: 'NFC-es de recebimento', icon: '🧾' },
    { href: '/cash', label: 'Caixa e pagamentos', icon: '💳' }, { href: '/financial', label: 'Visão geral do financeiro', icon: '💰' },
  ] },
  { title: 'Integração', icon: '🔗', items: [
    { href: '/integrations?tab=payments', label: 'Integração PIX', icon: '💠' }, { href: '/integrations?tab=pos', label: 'Integração POS', icon: '📟' },
    { href: '/settings?tab=store', label: 'Integração Pixel', icon: '🎯' }, { href: '/whatsapp', label: 'Integração WhatsApp Business', icon: '💬' },
    { href: '/integrations', label: 'Marketplaces e API', icon: '🔌' },
  ] },
  { title: 'Comandas', icon: '🪑', items: [
    { href: '/tables', label: 'Mesas', icon: '🪑' }, { href: '/comandas', label: 'Controle de comandas', icon: '📒' },
    { href: '/history?channel=TABLE', label: 'Histórico de comandas', icon: '🕓' }, { href: '/kds', label: 'Cozinha (KDS)', icon: '👨‍🍳' },
  ] },
  { title: 'Movimento', icon: '🧾', items: [
    { href: '/history', label: 'Histórico de vendas/pedidos', icon: '🧾' }, { href: '/scheduled', label: 'Vendas agendadas', icon: '⏰' },
    { href: '/orders', label: 'Lançamento manual de pedido', icon: '✍️' }, { href: '/releases', label: 'Liberações por senha', icon: '🛡️' },
  ] },
  { title: 'Relatórios', icon: '📊', items: reportMenu },
  { title: 'Cadastros', icon: '🗃️', items: [
    { href: '/employees', label: 'Funcionários', icon: '👥' }, { href: '/users', label: 'Usuários e permissões', icon: '🔐' },
    { href: '/shifts', label: 'Escalas', icon: '🕒' }, { href: '/purchasing', label: 'Fornecedores', icon: '🛒' },
    { href: '/carriers', label: 'Transportadoras', icon: '🚚' }, { href: '/units', label: 'Unidades', icon: '📍' },
    { href: '/companies', label: 'Empresas', icon: '🏢', masterOnly: true }, { href: '/provisioning', label: 'Provisionamento', icon: '⚙️', masterOnly: true },
  ] },
  { title: 'Fiscal / Tributos', icon: '📄', items: [
    { href: '/fiscal', label: 'Documentos fiscais', icon: '📄' }, { href: '/settings?tab=fiscal', label: 'Configurações fiscais', icon: '🛠️' }, { href: '/tax-rules', label: 'Correlação de tributos', icon: '％' },
    { href: '/tax-rules?tab=icms', label: 'Alíquotas e redução de ICMS', icon: '➗' }, { href: '/tax-rules?tab=pis', label: 'Percentual PIS/COFINS', icon: '🧮' },
    { href: '/fiscal-xmls', label: 'XMLs', icon: '🧩' }, { href: '/contingency', label: 'Contingências', icon: '🚨' },
    { href: '/reconciliation', label: 'Conciliação tributária', icon: '⚖️' }, { href: '/received-invoices', label: 'Notas recebidas', icon: '📥' },
    { href: '/received-invoices?tab=entry', label: 'Entrada de NF-e', icon: '📝' }, { href: '/natures', label: 'Naturezas de operação', icon: '📑' },
    { href: '/cst-map', label: 'Correlação CST ICMS x Entrada', icon: '🔁' },
  ] },
  { title: 'Configurações gerais', icon: '⚙️', items: [
    { href: '/settings', label: 'Empresa', icon: '⚙️' }, { href: '/schedule-settings', label: 'Agendamento de pedidos', icon: '⏰' },
    { href: '/users', label: 'Cadastros de usuários', icon: '🔐' }, { href: '/cover-events', label: 'Couvert artístico', icon: '🎤' },
    { href: '/order-statuses', label: 'Status dos pedidos', icon: '📝' }, { href: '/production', label: 'Gerenciadores de pedidos', icon: '🖨️' },
    { href: '/downloads', label: 'Downloads', icon: '⬇️' }, { href: '/audit', label: 'Auditoria', icon: '🛡️' },
    { href: '/plans', label: 'Planos e preços', icon: '💎', masterOnly: true }, { href: '/licenses', label: 'Licenças e módulos', icon: '🔑', masterOnly: true },
  ] },
];

export const topTabs: MenuItem[] = [
  { href: '/monitor', label: 'Pedidos', icon: '🧾' }, { href: '/comandas', label: 'Comandas', icon: '🍽️' }, { href: '/pdv', label: 'PDV', icon: '🖥️' },
];

export const menuCatalog: { href: string; label: string; group: string }[] = menuGroups.flatMap(group => group.items.filter(item => !item.masterOnly).map(item => ({ href: item.href, label: item.label, group: group.title })));

// Items that can never be hidden by the personalization editor, otherwise a tenant could lock itself out of the settings.
export const alwaysVisibleHrefs = ['/dashboard', '/settings'];

export const flows: { title: string; hrefs: string[] }[] = [
  { title: 'Fluxo de vendas', hrefs: ['/tables', '/pdv', '/monitor', '/kds', '/production', '/delivery', '/cash'] },
  { title: 'Cardápio e estoque', hrefs: ['/products', '/categories', '/promotions', '/scale-file', '/catalog', '/inventory', '/purchasing'] },
  { title: 'Equipe', hrefs: ['/employees', '/users', '/shifts'] },
  { title: 'Resultado financeiro', hrefs: ['/cash', '/financial', '/reports', '/fiscal', '/reconciliation'] },
  { title: 'Relacionamento', hrefs: ['/customers', '/coupons', '/reservations', '/whatsapp'] },
  { title: 'Plataforma', hrefs: ['/units', '/integrations', '/audit'] },
];

export const pathOf = (href: string) => href.split('?')[0];
export const moduleLabel = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.label ?? topTabs.find(tab => tab.href === href)?.label ?? href;
export const moduleIcon = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.icon ?? topTabs.find(tab => tab.href === href)?.icon ?? '•';
