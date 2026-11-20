import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { effectiveModules, globallyBlockedModules } from '../lib/licensing';
import { answerGuide, explainScreen, listTopics, topicById } from '../lib/guide/engine';

// RM Assistente — teaching mode. Read-only knowledge (menus, screens, fields and step-by-step procedures) built from the real screens; it never
// touches business data or changes anything, so every signed-in restaurant user may ask. What the user can actually open is still decided by
// each screen's own API permissions and the company's license; the answer only tells which one applies.
export const guideRoutes = Router();
guideRoutes.use(requireAuth, requireTenant);

async function modulesOf(tenantId: string): Promise<string[] | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { license: true } });
  if (!tenant?.license) return null;
  const grants = await prisma.tenantModule.findMany({ where: { tenantId }, select: { moduleKey: true, blocked: true, startsAt: true, endsAt: true } });
  const blocked = await globallyBlockedModules(async () => (await prisma.saaSModule.findMany({ where: { blocked: true }, select: { key: true } })).map(item => item.key));
  return effectiveModules(grants, blocked);
}

const pageSchema = z.string().trim().max(120).regex(/^\/[a-z0-9\-/?=&_.]*$/i).optional();

guideRoutes.post('/ask', async (req, res, next) => {
  try {
    const input = z.object({ question: z.string().trim().min(3).max(300), page: pageSchema, topicId: z.string().max(60).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Escreva uma pergunta de 3 a 300 caracteres' });
    const enabledModules = await modulesOf(req.auth!.tenantId!);
    return res.json(answerGuide(input.data.question, { page: input.data.page, role: req.auth!.role, enabledModules }));
  } catch (error) { return next(error); }
});

guideRoutes.get('/screen', async (req, res, next) => {
  try {
    const page = pageSchema.safeParse(req.query.page);
    if (!page.success || !page.data) return res.status(400).json({ message: 'Informe a tela (page)' });
    return res.json(explainScreen(page.data, req.auth!.role, await modulesOf(req.auth!.tenantId!)));
  } catch (error) { return next(error); }
});

guideRoutes.get('/topics', (_req, res) => res.json({ items: listTopics() }));

guideRoutes.get('/topics/:id', async (req, res, next) => {
  try {
    const topic = topicById(req.params.id, req.auth!.role, await modulesOf(req.auth!.tenantId!));
    return topic ? res.json(topic) : res.status(404).json({ message: 'Tópico não encontrado' });
  } catch (error) { return next(error); }
});
