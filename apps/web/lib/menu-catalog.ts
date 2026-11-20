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
    { href: '/crm', label: 'Clientes VIP e fidelização', icon: '👑' }, { href: '/coupons', label: 'Cupons de desconto', icon: '🏷️' }, { href: '/tables', label: 'QR Code na mesa', icon: '▦' },
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
    { href: '/settings?tab=fulfillment', label: 'Zonas não mapeadas', icon: '📍' },
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
    { href: '/history?channel=TABLE', label: 'Histórico de comandas', icon: '🕓' },
  ] },
  { title: 'Movimento', icon: '🧾', items: [
    { href: '/history', label: 'Histórico de vendas/pedidos', icon: '🧾' }, { href: '/scheduled', label: 'Vendas agendadas', icon: '⏰' },
    { href: '/orders', label: 'Lançamento manual de pedido', icon: '✍️' }, { href: '/releases', label: 'Liberações por senha', icon: '🛡️' },
  ] },
  // One central RM INTELLIGENCE module: the SUPER IA central, the assistant, the ten specialists and the classic panels (same routes as before, no duplicated entries).
  { title: 'RM INTELLIGENCE', icon: '🧠', items: [
    { href: '/ai', label: 'Central de Inteligência Empresarial', icon: '🧭' }, { href: '/intelligence?tab=assistant', label: 'RM Assistente', icon: '🧠' },
    { href: '/ai/finance', label: 'Análise Inteligente de Gestão Financeira', icon: '💰' }, { href: '/ai/stock', label: 'Análise Inteligente de Estoque', icon: '📦' },
    { href: '/ai/profit', label: 'Controle de Lucro e Rentabilidade', icon: '💹' }, { href: '/ai/sales', label: 'Inteligência de Vendas', icon: '📈' },
    { href: '/ai/purchasing', label: 'Inteligência de Compras e Reposição', icon: '🛒' }, { href: '/ai/customers', label: 'Inteligência de Clientes', icon: '👥' },
    { href: '/ai/delivery', label: 'Inteligência de Delivery', icon: '🛵' }, { href: '/ai/production', label: 'Inteligência de Produção', icon: '👨‍🍳' },
    { href: '/ai/waste', label: 'Inteligência de Desperdícios', icon: '🗑️' }, { href: '/ai/management', label: 'Inteligência Gerencial', icon: '📋' },
    { href: '/intelligence?tab=sales', label: 'Painel clássico · Vendas', icon: '📊' }, { href: '/intelligence?tab=stock', label: 'Painel clássico · Estoque', icon: '🗃️' },
    { href: '/intelligence?tab=business', label: 'Diagnóstico de negócios (IA)', icon: '✨' },
    { href: '/profit', label: 'RM Controle de Lucro', icon: '💹' }, { href: '/pricing', label: 'Formação de preço e rentabilidade', icon: '🏷️' },
  ] },
  { title: 'Operação RM', icon: '🏁', items: [
    { href: '/kds', label: 'RM KDS — Painel de Produção', icon: '👨‍🍳' }, { href: '/delivery', label: 'RM Delivery — Central de Delivery', icon: '🛵' }, { href: '/couriers', label: 'Entregadores', icon: '🏍️' },
  ] },
  { title: 'Relatórios', icon: '📊', items: reportMenu },
  { title: 'Cadastros', icon: '🗃️', items: [
    { href: '/employees', label: 'Funcionários', icon: '👥' }, { href: '/users', label: 'Usuários e permissões', icon: '🔐' },
    { href: '/shifts', label: 'Escalas', icon: '🕒' }, { href: '/commissions', label: 'Comissões', icon: '💸' }, { href: '/purchasing', label: 'Fornecedores', icon: '🛒' },
    { href: '/carriers', label: 'Transportadoras', icon: '🚚' }, { href: '/units', label: 'Unidades', icon: '📍' }, { href: '/network', label: 'Rede de unidades', icon: '🏢' },
    { href: '/companies', label: 'Empresas', icon: '🏢', masterOnly: true }, { href: '/provisioning', label: 'Provisionamento', icon: '⚙️', masterOnly: true },
  ] },
  { title: 'Fiscal / Tributos', icon: '📄', items: [
    { href: '/fiscal', label: 'Documentos fiscais', icon: '📄' }, { href: '/settings?tab=fiscal', label: 'Configurações fiscais', icon: '🛠️' }, { href: '/tax-rules', label: 'Correlação de tributos', icon: '％' },
    { href: '/tax-rules?tab=icms', label: 'Alíquotas e redução de ICMS', icon: '➗' }, { href: '/tax-rules?tab=pis', label: 'Percentual PIS/COFINS', icon: '🧮' },
    { href: '/fiscal-xmls', label: 'XMLs', icon: '🧩' }, { href: '/contingency', label: 'Contingências', icon: '🚨' },
    { href: '/bank-reconciliation', label: 'Conciliação bancária', icon: '🏦' }, { href: '/reconciliation', label: 'Conciliação tributária', icon: '⚖️' }, { href: '/received-invoices', label: 'Notas recebidas', icon: '📥' },
    { href: '/received-invoices?tab=entry', label: 'Entrada de NF-e', icon: '📝' }, { href: '/natures', label: 'Naturezas de operação', icon: '📑' },
    { href: '/cst-map', label: 'Correlação CST ICMS x Entrada', icon: '🔁' },
  ] },
  { title: 'Configurações gerais', icon: '⚙️', items: [
    { href: '/settings', label: 'Empresa', icon: '⚙️' }, { href: '/settings?tab=appearance', label: 'Aparência e personalização', icon: '🎨' }, { href: '/schedule-settings', label: 'Agendamento de pedidos', icon: '⏰' },
    { href: '/users', label: 'Cadastros de usuários', icon: '🔐' }, { href: '/cover-events', label: 'Couvert artístico', icon: '🎤' },
    { href: '/order-statuses', label: 'Status dos pedidos', icon: '📝' }, { href: '/production', label: 'Gerenciadores de pedidos', icon: '🖨️' },
    { href: '/downloads', label: 'Downloads', icon: '⬇️' }, { href: '/audit', label: 'Auditoria', icon: '🛡️' }, { href: '/support', label: 'Suporte e chamados', icon: '🎧' },
  ] },
  // RM Painel Admin only (masterOnly items are never listed for restaurant users).
  { title: 'Integração e Migração', icon: '🔄', items: [
    { href: '/migrations', label: 'Migração de dados (RM Smart Migration)', icon: '🧭', masterOnly: true },
  ] },
  { title: 'Gestão comercial', icon: '💼', items: [
    { href: '/commercial', label: 'Visão geral comercial', icon: '📊', masterOnly: true },
    { href: '/plans', label: 'Planos e montador', icon: '💎', masterOnly: true },
    { href: '/commercial?tab=modules', label: 'Módulos', icon: '🧩', masterOnly: true },
    { href: '/commercial?tab=campaigns', label: 'Promoções', icon: '🔖', masterOnly: true },
    { href: '/commercial?tab=coupons', label: 'Cupons', icon: '🏷️', masterOnly: true },
    { href: '/licenses', label: 'Clientes e assinaturas', icon: '🔑', masterOnly: true }, { href: '/modules', label: 'Módulos por empresa', icon: '🧩', masterOnly: true },
    { href: '/commercial?tab=billing', label: 'Cobranças e financeiro', icon: '🧾', masterOnly: true },
    { href: '/commercial?tab=reports', label: 'Relatórios comerciais', icon: '📑', masterOnly: true },
    { href: '/commercial?tab=history', label: 'Auditoria comercial', icon: '🛡️', masterOnly: true },
    { href: '/support', label: 'Suporte e interessados', icon: '🎧', masterOnly: true },
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
  { title: 'Equipe', hrefs: ['/employees', '/users', '/shifts', '/commissions'] },
  { title: 'Resultado financeiro', hrefs: ['/cash', '/financial', '/bank-reconciliation', '/reports', '/fiscal', '/reconciliation'] },
  { title: 'Relacionamento', hrefs: ['/customers', '/coupons', '/reservations', '/whatsapp'] },
  { title: 'Plataforma', hrefs: ['/units', '/network', '/integrations', '/audit'] },
];

export const pathOf = (href: string) => href.split('?')[0];
export const moduleLabel = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.label ?? topTabs.find(tab => tab.href === href)?.label ?? href;
export const moduleIcon = (href: string) => menuGroups.flatMap(group => group.items).find(item => pathOf(item.href) === href)?.icon ?? topTabs.find(tab => tab.href === href)?.icon ?? '•';

// Licensed module required by each screen (same keys enforced by the API). Screens not listed are core.
const moduleByPath: Record<string, string> = {
  '/orders': 'pos', '/pdv': 'pos', '/monitor': 'pos', '/comandas': 'pos', '/history': 'pos', '/scheduled': 'pos', '/releases': 'pos', '/scale-file': 'pos',
  '/tables': 'tables', '/reservations': 'tables', '/cover-events': 'tables', '/delivery': 'delivery', '/couriers': 'delivery',
  '/inventory': 'inventory', '/purchasing': 'inventory', '/carriers': 'inventory', '/financial': 'financial', '/cash': 'financial', '/payment-methods': 'financial', '/financial-categories': 'financial',
  '/employees': 'employees', '/shifts': 'employees', '/commissions': 'employees', '/kds': 'kds', '/production': 'kds', '/whatsapp': 'whatsapp', '/coupons': 'marketing', '/promotions': 'marketing', '/crm': 'marketing',
  '/fiscal': 'fiscal', '/tax-rules': 'fiscal', '/fiscal-xmls': 'fiscal', '/contingency': 'fiscal', '/reconciliation': 'fiscal', '/bank-reconciliation': 'financial', '/received-invoices': 'fiscal', '/natures': 'fiscal', '/cst-map': 'fiscal',
  '/reports': 'reports', '/integrations': 'integrations', '/intelligence': 'intelligence', '/profit': 'profit', '/pricing': 'profit',
};
// Pages that belong to a module (used by the admin panel to show what each checkbox unlocks).
export const pathsOfModule = (key: string): string[] => Object.entries(moduleByPath).filter(([, module]) => module === key).map(([path]) => path).sort();
export const moduleOfHref = (href: string): string | undefined => moduleByPath[pathOf(href)];
export const hrefAllowed = (href: string, enabledModules: string[] | null | undefined) => {
  const required = moduleOfHref(href);
  return !required || !enabledModules || enabledModules.includes(required);
};

// Screens whose API only answers to financial profiles (same lists as the backend permissions): never offered to the others, so no link ends in a predictable 403.
const FINANCE_ROLES = ['ADMIN', 'MANAGER', 'FINANCE'];
const rolesByPath: Record<string, string[]> = { '/intelligence': FINANCE_ROLES, '/profit': FINANCE_ROLES, '/pricing': FINANCE_ROLES, '/bank-reconciliation': FINANCE_ROLES, '/commissions': FINANCE_ROLES };
// RM Intelligence pages: '/ai' is the central, '/ai/<domain>' a specialist. The server decides which ones the profile may open (license AND role).
export const aiDomainOfHref = (href: string): string | null => { const match = pathOf(href).match(/^\/ai(?:\/([a-z]+))?$/); return match ? match[1] ?? 'central' : null; };
export type VisibilityContext = { enabledModules: string[] | null | undefined; role?: string; aiDomains: string[] | null | undefined };
// License (contracted module) and user permission are separate checks. While the license/permissions are still loading, only core items are shown, so menus do not flash and then disappear.
export function hrefVisible(href: string, context: VisibilityContext): boolean {
  const ai = aiDomainOfHref(href);
  if (ai !== null) return Boolean(context.aiDomains) && (ai === 'central' ? context.aiDomains!.length > 0 : context.aiDomains!.includes(ai));
  const roles = rolesByPath[pathOf(href)];
  if (roles && (!context.role || !roles.includes(context.role))) return false;
  if (moduleOfHref(href) && context.enabledModules === undefined) return false;
  return hrefAllowed(href, context.enabledModules);
}
