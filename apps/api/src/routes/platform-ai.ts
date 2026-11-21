import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster } from '../middleware/auth';
import { AI_PRESETS, aiSource, currentAiProvider, isProviderKey, refreshAiConfig, sealAiKey, type AiProviderKey } from '../lib/ai-provider';

// Platform AI provider (master admin only): choose provider and model, store the API key encrypted, and TEST it with a real call. The key is never
// returned by any endpoint. Until a test succeeds the status says "not verified": the system never presents AI as working without proof.
export const platformAiRoutes = Router();
platformAiRoutes.use(requireAuth, requireMaster);

const httpsOrLocal = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)); } catch { return false; } };
const saveSchema = z.object({
  provider: z.string().refine(isProviderKey, 'Provedor desconhecido'),
  model: z.string().trim().min(2).max(120),
  baseUrl: z.string().trim().max(300).refine(httpsOrLocal, 'Use um endereço https').nullable().optional(),
  apiKey: z.string().trim().min(8).max(400).optional(),
});

async function view() {
  const row = await prisma.platformAiConfig.findUnique({ where: { id: 'default' }, select: { provider: true, model: true, baseUrl: true, validatedAt: true, lastError: true, updatedAt: true } });
  const source = aiSource();
  const status = source.source === 'none' ? 'NOT_CONFIGURED' : source.lastError ? 'FAILED' : source.validatedAt ? 'VERIFIED' : 'CONFIGURED_UNVERIFIED';
  return {
    status, source: source.source, provider: source.provider, model: source.model, baseUrl: source.baseUrl, validatedAt: source.validatedAt, lastError: source.lastError,
    keyStored: Boolean(row), environmentConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), updatedAt: row?.updatedAt ?? null,
    presets: Object.entries(AI_PRESETS).map(([key, preset]) => ({ key, label: preset.label, baseUrl: preset.baseUrl, suggestedModel: preset.suggestedModel, kind: preset.kind })),
    note: status === 'VERIFIED' ? 'Provedor validado com uma chamada real.' : status === 'NOT_CONFIGURED' ? 'Nenhum provedor de IA configurado. As análises determinísticas continuam funcionando; respostas geradas por IA ficam indisponíveis.' : 'Configurado, mas ainda não validado: use "Testar conexão".',
  };
}

platformAiRoutes.get('/', async (_req, res, next) => { try { return res.json(await view()); } catch (error) { return next(error); } });

platformAiRoutes.put('/', async (req, res, next) => {
  try {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Dados inválidos' });
    const { model, apiKey } = parsed.data; const provider = parsed.data.provider as AiProviderKey;
    const baseUrl = parsed.data.baseUrl || null;
    if (provider === 'custom' && !baseUrl) return res.status(400).json({ message: 'Informe o endereço (https) do provedor compatível com OpenAI' });
    const existing = await prisma.platformAiConfig.findUnique({ where: { id: 'default' } });
    if (!apiKey && !existing) return res.status(400).json({ message: 'Informe a chave de API' });
    const apiKeyEnc = apiKey ? sealAiKey(apiKey) : existing!.apiKeyEnc;
    await prisma.platformAiConfig.upsert({ where: { id: 'default' }, create: { id: 'default', provider, model, baseUrl, apiKeyEnc, updatedById: req.auth!.userId }, update: { provider, model, baseUrl, apiKeyEnc, validatedAt: null, lastError: null, updatedById: req.auth!.userId } });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'PLATFORM_AI_CONFIGURED', entityType: 'PlatformAiConfig', entityId: 'default', metadata: { provider, model, baseHost: baseUrl ? new URL(baseUrl).host : null, keyChanged: Boolean(apiKey) } } });
    await refreshAiConfig(prisma);
    return res.json(await view());
  } catch (error) { return next(error); }
});

platformAiRoutes.delete('/', async (req, res, next) => {
  try {
    await prisma.platformAiConfig.deleteMany({ where: { id: 'default' } });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'PLATFORM_AI_REMOVED', entityType: 'PlatformAiConfig', entityId: 'default' } });
    await refreshAiConfig(prisma);
    return res.json(await view());
  } catch (error) { return next(error); }
});

// A real call to the provider: proves the key, the model and the endpoint work. Only a status code is reported on failure (never the key or the body).
platformAiRoutes.post('/test', async (req, res, next) => {
  try {
    const provider = currentAiProvider();
    if (!provider) return res.status(409).json({ ok: false, message: 'Nenhum provedor de IA configurado.' });
    const started = Date.now();
    try {
      // The WhatsApp attendant needs tool calling: prove the configured model can call a tool, not only answer text (checked first; the plain call below stays the last request).
      let toolCalling: 'ok' | 'unsupported' | 'failed' = 'unsupported';
      if (provider.chat) {
        try {
          const probe = await provider.chat({ system: 'Você é um verificador. Use a ferramenta pedida.', messages: [{ role: 'user', content: 'Chame a ferramenta ping com value="ok".' }], tools: [{ name: 'ping', description: 'Verifica a conexão.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }], maxTokens: 64, temperature: 0 });
          toolCalling = probe.toolCalls.some(call => call.name === 'ping') ? 'ok' : 'failed';
        } catch { toolCalling = 'failed'; }
      }
      const answer = await provider.answerDetailed?.({ system: 'Você é um verificador de conexão.', question: 'Responda apenas com a palavra OK.', maxTokens: 16 }) ?? { text: await provider.answer({ system: 'Você é um verificador de conexão.', question: 'Responda apenas com a palavra OK.', maxTokens: 16 }) ?? '', model: '', inputTokens: null, outputTokens: null };
      if (!answer.text) throw new Error('empty answer');
      await prisma.platformAiConfig.updateMany({ where: { id: 'default' }, data: { validatedAt: new Date(), lastError: null } }); await refreshAiConfig(prisma);
      return res.json({ ok: true, latencyMs: Date.now() - started, model: answer.model || aiSource().model, status: (await view()).status, toolCalling });
    } catch (error) {
      const message = error instanceof Error && /^AI provider error \d+$/.test(error.message) ? `${error.message}. Confira a chave, o modelo e o endereço.` : error instanceof Error && error.name === 'TimeoutError' ? 'O provedor não respondeu a tempo.' : 'Falha ao conectar ao provedor. Confira a chave, o modelo e o endereço.';
      await prisma.platformAiConfig.updateMany({ where: { id: 'default' }, data: { validatedAt: null, lastError: message } }); await refreshAiConfig(prisma);
      return res.status(502).json({ ok: false, message, latencyMs: Date.now() - started });
    }
  } catch (error) { return next(error); }
});
