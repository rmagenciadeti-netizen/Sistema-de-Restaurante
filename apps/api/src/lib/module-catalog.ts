import { prisma } from './prisma';
import { MODULE_CATALOG, MODULE_KEYS, type ModuleKey } from './licensing';

export const isFeatureLinked = (key: string) => (MODULE_KEYS as readonly string[]).includes(key);

// Validates a set of module keys against the commercial catalog: they must exist, be linked to a real feature, not be archived and have their dependencies in the same set.
export async function moduleSetProblem(keys: string[], alreadyContracted: string[] = []): Promise<string | null> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return null;
  const found = await prisma.saaSModule.findMany({ where: { key: { in: unique } }, select: { key: true, name: true, status: true, dependsOn: true } });
  for (const key of unique) {
    const module = found.find(item => item.key === key);
    if (!module) return `Módulo inexistente no catálogo: ${key}`;
    if (!isFeatureLinked(key)) return `Módulo "${module.name}" não implementado/indisponível: não possui funcionalidade vinculada`;
    if (module.status === 'ARCHIVED' && !alreadyContracted.includes(key)) return `Módulo "${module.name}" está arquivado`;
    const missing = module.dependsOn.filter(dependency => !unique.includes(dependency));
    if (missing.length > 0) return `Módulo "${module.name}" depende de: ${missing.join(', ')}`;
  }
  return null;
}

// Catalog data for every module the system enforces. Typed as Record<ModuleKey, ...>: adding a key to MODULE_CATALOG without describing it here
// fails the build, so the admin panel never depends on someone typing keys by hand.
export const MODULE_DEFAULTS: Record<ModuleKey, { description: string; category: string; icon: string }> = {
  pos: { description: 'PDV, comandas, pedidos e carrinho de mesa', category: 'Operação', icon: '🖥️' },
  tables: { description: 'Mapa de mesas, QR Code e reservas', category: 'Operação', icon: '🪑' },
  delivery: { description: 'Central de delivery, zonas e entregadores', category: 'Operação', icon: '🛵' },
  kds: { description: 'Painel de produção por setor', category: 'Operação', icon: '👨‍🍳' },
  printing: { description: 'Impressoras, setores e agente de impressão', category: 'Operação', icon: '🖨️' },
  inventory: { description: 'Estoque, ficha técnica, fornecedores e compras', category: 'Gestão', icon: '📦' },
  financial: { description: 'Contas a pagar/receber, caixa e formas de pagamento', category: 'Gestão', icon: '💰' },
  employees: { description: 'Equipe, escalas e comissões', category: 'Gestão', icon: '👥' },
  reports: { description: 'Central de relatórios e exportações', category: 'Gestão', icon: '📊' },
  fiscal: { description: 'NF-e, NFC-e e regras tributárias', category: 'Fiscal', icon: '📄' },
  marketing: { description: 'Cupons, promoções e fidelização de clientes', category: 'Relacionamento', icon: '🏷️' },
  whatsapp: { description: 'Atendimento e pedidos via WhatsApp', category: 'Relacionamento', icon: '💬' },
  integrations: { description: 'PIX, POS e marketplaces', category: 'Integrações', icon: '🔌' },
  intelligence: { description: 'Assistente, previsões e alertas com os dados reais do restaurante', category: 'Inteligência', icon: '🧠' },
  profit: { description: 'Rentabilidade, CMV, ficha técnica com custos e resultado operacional', category: 'Gestão', icon: '💹' },
  network: { description: 'Comparação e consolidado entre unidades e preço por unidade', category: 'Gestão', icon: '🏢' },
};

// Creates the catalog rows of modules the code enforces but the database does not have yet. Never touches existing rows, so names, prices,
// promotions, status and global blocks edited in the admin panel are kept; running it twice changes nothing.
export async function ensureModuleCatalog(): Promise<number> {
  const existing = new Set((await prisma.saaSModule.findMany({ select: { key: true } })).map(row => row.key));
  const missing = MODULE_CATALOG.filter(item => !existing.has(item.key));
  if (missing.length === 0) return 0;
  const result = await prisma.saaSModule.createMany({ data: missing.map(item => ({ key: item.key, name: item.name, ...MODULE_DEFAULTS[item.key] })), skipDuplicates: true });
  return result.count;
}

let ensured: Promise<number> | null = null;
// Once per process (startup and first admin request); a failure is not cached so the next request retries.
export function ensureModuleCatalogOnce(): Promise<number> {
  ensured ??= ensureModuleCatalog().catch(error => { ensured = null; throw error; });
  return ensured;
}
