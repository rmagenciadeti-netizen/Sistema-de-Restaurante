import { prisma } from './prisma';
import { MODULE_KEYS } from './licensing';

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
