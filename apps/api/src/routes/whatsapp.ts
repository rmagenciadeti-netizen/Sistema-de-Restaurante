import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { CASH_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings } from '../lib/settings';
import { MANAGER_STALE_MS } from '../lib/whatsapp-sessions';
import { currentAiProvider } from '../lib/ai-provider';
import { AUTO_MESSAGES, autoMessageDef } from '../lib/whatsapp-messages';
import { loadBotEnv, respond } from '../lib/whatsapp-bot';

export const whatsappRoutes = Router();
whatsappRoutes.use(requireAuth, requireTenant, requireRoles(...CASH_ROLES));
// This endpoint creates an auditable outbox item. A configured official provider and worker are required to send messages.
whatsappRoutes.post('/outbox', async (req, res, next) => {
  try { const input = z.object({ toPhone: z.string().min(8).max(30), template: z.string().min(1).max(100), orderId: z.string().uuid().optional(), payload: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const tenantId = req.auth!.tenantId!; if (input.data.orderId && !await prisma.order.findFirst({ where: { id: input.data.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } })) return res.status(404).json({ message: 'Order not found' });
    // express.json has already restricted nested payload values to JSON.
    const payload = input.data.payload as Prisma.InputJsonObject | undefined;
    const message = await prisma.whatsappMessage.create({ data: { ...input.data, payload, tenantId, status: 'QUEUED' } }); return res.status(202).json({ message, delivery: 'QUEUED_NOT_SENT', note: 'Configure um provedor oficial e worker para realizar o envio.' }); }
  catch (error) { return next(error); }
});
whatsappRoutes.get('/outbox', async (req, res, next) => {
  try { const items = await prisma.whatsappMessage.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
whatsappRoutes.post('/outbox/:id/retry', async (req, res, next) => {
  try {
    const updated = await prisma.whatsappMessage.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, status: 'FAILED', toPhone: { not: 'redacted' } }, data: { status: 'QUEUED', error: null } });
    return updated.count === 1 ? res.status(204).end() : res.status(409).json({ message: 'Only failed messages can be retried' });
  } catch (error) { return next(error); }
});


// ---------------------------------------------------------------------------------------------------------------------
// WhatsApp Web (QR) session, conversations, automatic messages, knowledge base and bot simulator.
// The session itself lives in the session manager process (lib/whatsapp-sessions.ts); these routes only coordinate through the DB.
// ---------------------------------------------------------------------------------------------------------------------
const manage = requireRoles(...MANAGEMENT_ROLES);
const sessionView = async (tenantId: string) => {
  const [row, manager] = await Promise.all([
    prisma.whatsappSession.upsert({ where: { tenantId }, create: { tenantId }, update: {} }),
    prisma.whatsappManager.findUnique({ where: { id: 'default' } }),
  ]);
  return {
    status: row.status, desired: row.desired === 'CONNECTED' || row.desired === 'RENEW' ? 'CONNECTED' : 'DISCONNECTED', qr: row.status === 'QR_READY' ? row.qr : null, phone: row.phone, pushName: row.pushName,
    lastError: row.lastError, connectedAt: row.connectedAt, managerOnline: Boolean(manager && Date.now() - manager.heartbeatAt.getTime() < MANAGER_STALE_MS),
    cloudConfigured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID), aiConfigured: currentAiProvider() !== null,
  };
};
// Opening the connection screen marks the session as "being watched" (the manager then keeps renewing expired QR Codes). With ?autoConnect=1 and a number
// that was never paired, a manager/admin also starts the connection by itself, so the QR Code appears without pressing anything.
whatsappRoutes.get('/session', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.whatsappSession.upsert({ where: { tenantId }, create: { tenantId }, update: { viewedAt: new Date() } });
    const canManage = MANAGEMENT_ROLES.includes(req.auth!.role);
    if (req.query.autoConnect === '1' && canManage && !current.phone && current.desired !== 'CONNECTED' && current.desired !== 'RENEW') {
      await prisma.whatsappSession.update({ where: { tenantId }, data: { desired: 'CONNECTED', status: 'CONNECTING', qr: null, lastError: null, viewedAt: new Date() } });
      await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'WHATSAPP_SESSION_CONNECT', entityType: 'WhatsappSession', entityId: tenantId, metadata: { auto: true } } });
    }
    return res.json(await sessionView(tenantId));
  } catch (error) { return next(error); }
});
// "Renovar": restarts the connection (a fresh QR Code when the number is not paired). Works while connecting, waiting for the scan or after an error.
whatsappRoutes.post('/session/renew', manage, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    await prisma.whatsappSession.upsert({ where: { tenantId }, create: { tenantId, desired: 'RENEW', status: 'CONNECTING' }, update: { desired: 'RENEW', status: 'CONNECTING', qr: null, lastError: null, viewedAt: new Date() } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'WHATSAPP_SESSION_RENEW', entityType: 'WhatsappSession', entityId: tenantId } });
    return res.status(202).json(await sessionView(tenantId));
  } catch (error) { return next(error); }
});
whatsappRoutes.post('/session/connect', manage, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.whatsappSession.findUnique({ where: { tenantId } });
    if (current?.status === 'CONNECTED' && current.desired === 'CONNECTED') return res.status(202).json(await sessionView(tenantId));
    await prisma.whatsappSession.upsert({ where: { tenantId }, create: { tenantId, desired: 'CONNECTED', status: 'CONNECTING' }, update: { desired: 'CONNECTED', status: 'CONNECTING', qr: null, lastError: null } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'WHATSAPP_SESSION_CONNECT', entityType: 'WhatsappSession', entityId: tenantId } });
    return res.status(202).json(await sessionView(tenantId));
  } catch (error) { return next(error); }
});
whatsappRoutes.post('/session/disconnect', manage, async (req, res, next) => {
  try {
    const parsed = z.object({ logout: z.boolean().default(false) }).safeParse(req.body ?? {}); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const tenantId = req.auth!.tenantId!;
    await prisma.whatsappSession.upsert({ where: { tenantId }, create: { tenantId }, update: { desired: parsed.data.logout ? 'LOGOUT' : 'DISCONNECTED', ...(parsed.data.logout ? {} : { qr: null }) } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: parsed.data.logout ? 'WHATSAPP_SESSION_LOGOUT' : 'WHATSAPP_SESSION_DISCONNECT', entityType: 'WhatsappSession', entityId: tenantId } });
    return res.status(202).json(await sessionView(tenantId));
  } catch (error) { return next(error); }
});

whatsappRoutes.get('/stats', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!; const today = new Date(new Date().setHours(0, 0, 0, 0));
    const [conversations, inboundToday, botRepliesToday, handoffOpen, unanswered, outboundQueued] = await Promise.all([
      prisma.whatsappConversation.count({ where: { tenantId } }),
      prisma.whatsappChatMessage.count({ where: { tenantId, direction: 'IN', createdAt: { gte: today } } }),
      prisma.whatsappChatMessage.count({ where: { tenantId, source: 'BOT', createdAt: { gte: today } } }),
      prisma.whatsappConversation.count({ where: { tenantId, handoff: true, OR: [{ handoffUntil: null }, { handoffUntil: { gt: new Date() } }] } }),
      prisma.whatsappUnanswered.count({ where: { tenantId } }),
      prisma.whatsappMessage.count({ where: { tenantId, status: 'QUEUED' } }),
    ]);
    return res.json({ conversations, inboundToday, botRepliesToday, handoffOpen, unanswered, outboundQueued });
  } catch (error) { return next(error); }
});

whatsappRoutes.get('/conversations', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : ''; const filter = req.query.filter;
    const tenantId = req.auth!.tenantId!;
    const where: Prisma.WhatsappConversationWhereInput = {
      tenantId,
      ...(filter === 'handoff' ? { handoff: true } : {}), ...(filter === 'unread' ? { unread: { gt: 0 } } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q.replace(/\D/g, '') || '§' } }] } : {}),
    };
    const rows = await prisma.whatsappConversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: 100, include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true } } } });
    const now = new Date();
    return res.json({ items: rows.map(row => ({ id: row.id, phone: row.phone, name: row.name, lastMessageAt: row.lastMessageAt, lastMessage: row.messages[0]?.body ?? null, unread: row.unread, handoff: row.handoff && (!row.handoffUntil || row.handoffUntil > now), optOut: row.optOut })), total: rows.length });
  } catch (error) { return next(error); }
});
whatsappRoutes.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const conversation = await prisma.whatsappConversation.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    const rows = await prisma.whatsappChatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, direction: true, source: true, body: true, createdAt: true } });
    await prisma.whatsappConversation.update({ where: { id: conversation.id }, data: { unread: 0 } });
    return res.json({ items: rows.reverse(), total: rows.length });
  } catch (error) { return next(error); }
});
whatsappRoutes.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const conversation = await prisma.whatsappConversation.findFirst({ where: { id: req.params.id, tenantId } });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    const phone = conversation.phone ?? (conversation.jid.endsWith('@s.whatsapp.net') ? conversation.jid.split('@')[0] : null);
    if (!phone) return res.status(409).json({ message: 'Este contato não tem número de telefone identificado' });
    const settings = await loadSettings(prisma, tenantId);
    await prisma.$transaction([
      prisma.whatsappMessage.create({ data: { tenantId, toPhone: phone, template: 'free_text', payload: { text: parsed.data.text }, status: 'QUEUED' } }),
      prisma.whatsappConversation.update({ where: { id: conversation.id }, data: { handoff: true, handoffUntil: new Date(Date.now() + settings.whatsapp.handoffMinutes * 60_000) } }),
    ]);
    return res.status(202).json({ queued: true });
  } catch (error) { return next(error); }
});
whatsappRoutes.patch('/conversations/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ handoff: z.boolean().optional(), optOut: z.boolean().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const tenantId = req.auth!.tenantId!;
    const settings = await loadSettings(prisma, tenantId);
    const updated = await prisma.whatsappConversation.updateMany({ where: { id: req.params.id, tenantId }, data: { ...(parsed.data.handoff === undefined ? {} : parsed.data.handoff ? { handoff: true, handoffUntil: new Date(Date.now() + settings.whatsapp.handoffMinutes * 60_000) } : { handoff: false, handoffUntil: null, stateData: Prisma.JsonNull }), ...(parsed.data.optOut === undefined ? {} : { optOut: parsed.data.optOut }) } });
    if (updated.count !== 1) return res.status(404).json({ message: 'Conversation not found' });
    const row = await prisma.whatsappConversation.findUniqueOrThrow({ where: { id: req.params.id } });
    return res.json({ id: row.id, phone: row.phone, name: row.name, lastMessageAt: row.lastMessageAt, unread: row.unread, handoff: row.handoff, optOut: row.optOut });
  } catch (error) { return next(error); }
});

const autoView = (def: typeof AUTO_MESSAGES[number], row?: { enabled: boolean; body: string } | null) => ({ key: def.key, title: def.title, description: def.description, enabled: row ? row.enabled : def.defaultEnabled, body: row?.body ?? def.defaultBody, defaultBody: def.defaultBody, variables: def.variables });
whatsappRoutes.get('/auto-messages', async (req, res, next) => {
  try {
    const rows = await prisma.whatsappAutoMessage.findMany({ where: { tenantId: req.auth!.tenantId! } });
    const byKey = new Map(rows.map(row => [row.key, row]));
    return res.json({ items: AUTO_MESSAGES.map(def => autoView(def, byKey.get(def.key))), total: AUTO_MESSAGES.length });
  } catch (error) { return next(error); }
});
whatsappRoutes.put('/auto-messages/:key', manage, async (req, res, next) => {
  try {
    const def = autoMessageDef(req.params.key); if (!def) return res.status(404).json({ message: 'Unknown message' });
    const parsed = z.object({ enabled: z.boolean(), body: z.string().trim().min(1).max(1000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const unknown = [...parsed.data.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(match => match[1]).filter(name => !def.variables.includes(name));
    if (unknown.length) return res.status(400).json({ message: `Variáveis desconhecidas: ${[...new Set(unknown)].join(', ')}` });
    const tenantId = req.auth!.tenantId!;
    const row = await prisma.whatsappAutoMessage.upsert({ where: { tenantId_key: { tenantId, key: def.key } }, create: { tenantId, key: def.key, ...parsed.data }, update: parsed.data });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'WHATSAPP_AUTO_MESSAGE_UPDATED', entityType: 'WhatsappAutoMessage', entityId: def.key, metadata: { enabled: parsed.data.enabled } } });
    return res.json(autoView(def, row));
  } catch (error) { return next(error); }
});
whatsappRoutes.post('/auto-messages/:key/reset', manage, async (req, res, next) => {
  try {
    const def = autoMessageDef(req.params.key); if (!def) return res.status(404).json({ message: 'Unknown message' });
    await prisma.whatsappAutoMessage.deleteMany({ where: { tenantId: req.auth!.tenantId!, key: def.key } });
    return res.json(autoView(def));
  } catch (error) { return next(error); }
});

const knowledgeSchema = z.object({ title: z.string().trim().min(2).max(100), keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(20), answer: z.string().trim().min(1).max(1500), active: z.boolean().optional() });
whatsappRoutes.get('/knowledge', async (req, res, next) => {
  try { const items = await prisma.whatsappKnowledge.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { createdAt: 'desc' }, take: 300 }); return res.json({ items, total: items.length }); } catch (error) { return next(error); }
});
whatsappRoutes.post('/knowledge', manage, async (req, res, next) => {
  try {
    const parsed = knowledgeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (await prisma.whatsappKnowledge.count({ where: { tenantId } }) >= 300) return res.status(409).json({ message: 'Limite de 300 respostas atingido' });
    return res.status(201).json(await prisma.whatsappKnowledge.create({ data: { ...parsed.data, tenantId } }));
  } catch (error) { return next(error); }
});
whatsappRoutes.patch('/knowledge/:id', manage, async (req, res, next) => {
  try {
    const parsed = knowledgeSchema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const updated = await prisma.whatsappKnowledge.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, data: parsed.data });
    if (updated.count !== 1) return res.status(404).json({ message: 'Knowledge entry not found' });
    return res.json(await prisma.whatsappKnowledge.findUniqueOrThrow({ where: { id: req.params.id } }));
  } catch (error) { return next(error); }
});
whatsappRoutes.delete('/knowledge/:id', manage, async (req, res, next) => {
  try { const removed = await prisma.whatsappKnowledge.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); return removed.count === 1 ? res.status(204).end() : res.status(404).json({ message: 'Knowledge entry not found' }); } catch (error) { return next(error); }
});
whatsappRoutes.get('/unanswered', async (req, res, next) => {
  try { const items = await prisma.whatsappUnanswered.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: [{ count: 'desc' }, { lastAskedAt: 'desc' }], take: 100 }); return res.json({ items, total: items.length }); } catch (error) { return next(error); }
});
whatsappRoutes.delete('/unanswered/:id', manage, async (req, res, next) => {
  try { const removed = await prisma.whatsappUnanswered.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); return removed.count === 1 ? res.status(204).end() : res.status(404).json({ message: 'Not found' }); } catch (error) { return next(error); }
});

// Runs the real bot logic against real tenant data without sending anything or writing state (reservations are not created).
const stateSchema = z.object({ step: z.enum(['RESERVE_PEOPLE', 'RESERVE_WHEN', 'RESERVE_CONFIRM']), people: z.number().int().optional(), at: z.string().optional() }).nullable();
whatsappRoutes.post('/bot/simulate', async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().trim().min(1).max(1000), state: stateSchema.optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const env = await loadBotEnv(prisma, tenantId);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } });
    const result = await respond(prisma, env, { text: parsed.data.text, phone: null, name: user?.name ?? 'Cliente', state: parsed.data.state ?? null, greetDue: !parsed.data.state && /^(oi|ola|olá|bom dia|boa tarde|boa noite)\b/i.test(parsed.data.text) }, { dryRun: true });
    return res.json({ replies: result.replies, state: result.state, intent: result.intent, handoff: result.handoff });
  } catch (error) { return next(error); }
});
