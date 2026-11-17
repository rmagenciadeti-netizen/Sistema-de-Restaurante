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
    { href: '/coupons', label: 'Cupons de desconto', icon: '🏷️' }, { href: '/reservations', label: 'Reservas', icon: '📅' },
  ] },
  { title: 'Gerenciamento de produtos', icon: '📦', items: [
    { href: '/categories', label: 'Categorias', icon: '📋' }, { href: '/production', label: 'Setores de produção e impressão', icon: '🖨️' },
    { href: '/products', label: 'Produtos', icon: '🍔' }, { href: '/bulk-adjust', label: 'Ajuste em massa', icon: '🔄' },
    { href: '/category-hours', label: 'Exibição das categorias', icon: '🕘' }, { href: '/promotions', label: 'Promoções', icon: '🔖' },
    { href: '/scale-file', label: 'Arquivo para balança', icon: '⚖️' }, { href: '/catalog', label: 'Adicionais e combos', icon: '🧀' },
    { href: '/inventory', label: 'Estoque e fichas', icon: '📦' },
  ] },
  { title: 'Controle de entrega', icon: '🛵', items: [
    { href: '/delivery', label: 'Entregas e zonas', icon: '🛵' }, { href: '/couriers', label: 'Entregadores', icon: '🏍️' },
  ] },
  { title: 'Gerenciamento financeiro', icon: '💵', items: [
    { href: '/cash', label: 'Caixa e pagamentos', icon: '💳' }, { href: '/payment-methods', label: 'Formas de pagamento', icon: '💶' },
    { href: '/financial', label: 'Contas a pagar e receber', icon: '💰' }, { href: '/financial-categories', label: 'Categorias de contas', icon: '🗂️' },
  ] },
  { title: 'Integração', icon: '🔗', items: [
    { href: '/integrations', label: 'PIX, POS e marketplaces', icon: '🔌' }, { href: '/whatsapp', label: 'WhatsApp', icon: '💬' },
  ] },
  { title: 'Comandas', icon: '🪑', items: [
    { href: '/tables', label: 'Mesas e QR Code', icon: '🪑' }, { href: '/comandas', label: 'Controle de comandas', icon: '📒' },
    { href: '/history?channel=TABLE', label: 'Histórico de comandas', icon: '🕓' }, { href: '/kds', label: 'Cozinha (KDS)', icon: '👨‍🍳' },
  ] },
  { title: 'Movimento', icon: '🧾', items: [
    { href: '/history', label: 'Histórico de vendas/pedidos', icon: '🧾' }, { href: '/scheduled', label: 'Vendas agendadas', icon: '⏰' },
    { href: '/orders', label: 'Lançamento manual de pedido', icon: '✍️' }, { href: '/releases', label: 'Liberações por senha', icon: '🛡️' },
  ] },
  { title: 'Relatórios', icon: '📊', items: reportMenu },
  { title: 'Cadastros', icon: '🗃️', items: [
    { href: '/employees', label: 'Funcionários', icon: '👥' }, { href: '/users', label: 'Usuários e permissões', icon: '🔐' },
    { href: '/shifts', label: 'Escalas', icon: '🕒' }, { href: '/purchasing', label: 'Fornecedores e compras', icon: '🛒' },
    { href: '/carriers', label: 'Transportadoras', icon: '🚚' }, { href: '/units', label: 'Unidades', icon: '📍' },
    { href: '/companies', label: 'Empresas', icon: '🏢', masterOnly: true }, { href: '/provisioning', label: 'Provisionamento', icon: '⚙️', masterOnly: true },
  ] },
  { title: 'Fiscal / Tributos', icon: '📄', items: [
    { href: '/fiscal', label: 'Documentos fiscais', icon: '📄' }, { href: '/tax-rules', label: 'Regras tributárias', icon: '％' },
  ] },
  { title: 'Configurações gerais', icon: '⚙️', items: [
    { href: '/settings', label: 'Empresa e preferências', icon: '⚙️' }, { href: '/schedule-settings', label: 'Agendamento de pedidos', icon: '⏰' },
    { href: '/cover-events', label: 'Couvert artístico', icon: '🎤' }, { href: '/order-statuses', label: 'Status dos pedidos', icon: '📝' },
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
  { title: 'Resultado financeiro', hrefs: ['/cash', '/financial', '/reports', '/fiscal'] },
  { title: 'Relacionamento', hrefs: ['/customers', '/coupons', '/reservations', '/whatsapp'] },
  { title: 'Plataforma', hrefs: ['/units', '/integrations', '/audit'] },
];

export const pathOf = (href: string) => href.split('?')[0];
export const moduleLabel = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.label ?? topTabs.find(tab => tab.href === href)?.label ?? href;
export const moduleIcon = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.icon ?? topTabs.find(tab => tab.href === href)?.icon ?? '•';
