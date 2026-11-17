import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Prisma, TicketPriority, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster, requireTenant } from '../middleware/auth';
import { audit } from './commercial';

// ---------- Restaurant side: a tenant only ever sees its own tickets and never internal notes ----------
export const supportRoutes = Router();
supportRoutes.use(requireAuth, requireTenant);

const openSchema = z.object({
  subject: z.string().trim().min(5).max(160), category: z.string().trim().min(2).max(40).default('Geral'),
  priority: z.nativeEnum(TicketPriority).default('NORMAL'), body: z.string().trim().min(5).max(4000),
});

supportRoutes.get('/tickets', async (req, res, next) => {
  try {
    const items = await prisma.supportTicket.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, seq: true, subject: true, category: true, priority: true, status: true, createdAt: true, updatedAt: true, resolvedAt: true } });
    return res.json({ items });
  } catch (error) { return next(error); }
});

supportRoutes.post('/tickets', async (req, res, next) => {
  try {
    const input = openSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe o assunto (mín. 5 caracteres) e a descrição', errors: input.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const open = await prisma.supportTicket.count({ where: { tenantId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] } } });
    if (open >= 20) return res.status(429).json({ message: 'Limite de chamados em aberto atingido. Aguarde o atendimento dos atuais.' });
    const ticket = await prisma.supportTicket.create({
      data: { tenantId, openedByUserId: req.auth!.userId, subject: input.data.subject, category: input.data.category, priority: input.data.priority, messages: { create: { authorUserId: req.auth!.userId, body: input.data.body } } },
      select: { id: true, seq: true, status: true },
    });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'SUPPORT_TICKET_OPENED', entityType: 'SupportTicket', entityId: ticket.id, metadata: { seq: ticket.seq } } });
    return res.status(201).json(ticket);
  } catch (error) { return next(error); }
});

const thread = (ticketId: string, includeInternal: boolean) => prisma.supportMessage.findMany({
  where: { ticketId, ...(includeInternal ? {} : { internal: false }) }, orderBy: { createdAt: 'asc' }, select: { id: true, body: true, fromAdmin: true, internal: true, createdAt: true, authorUserId: true },
});

supportRoutes.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, select: { id: true, seq: true, subject: true, category: true, priority: true, status: true, createdAt: true, updatedAt: true, resolvedAt: true } });
    if (!ticket) return res.status(404).json({ message: 'Chamado não encontrado' });
    return res.json({ ticket, messages: await thread(ticket.id, false) });
  } catch (error) { return next(error); }
});

supportRoutes.post('/tickets/:id/messages', async (req, res, next) => {
  try {
    const input = z.object({ body: z.string().trim().min(2).max(4000) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Escreva a mensagem' });
    const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, select: { id: true, status: true } });
    if (!ticket) return res.status(404).json({ message: 'Chamado não encontrado' });
    if (ticket.status === 'CLOSED') return res.status(409).json({ message: 'Chamado encerrado. Abra um novo chamado.' });
    await prisma.$transaction([
      prisma.supportMessage.create({ data: { ticketId: ticket.id, authorUserId: req.auth!.userId, body: input.data.body } }),
      prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: ticket.status === 'RESOLVED' || ticket.status === 'WAITING_CUSTOMER' ? 'OPEN' : ticket.status, resolvedAt: null } }),
    ]);
    return res.status(201).json({ ok: true });
  } catch (error) { return next(error); }
});

// ---------- RM Painel Admin side ----------
export const supportAdminRoutes = Router();
supportAdminRoutes.use(requireAuth, requireMaster);

supportAdminRoutes.get('/support/tickets', async (req, res, next) => {
  try {
    const query = z.object({ status: z.nativeEnum(TicketStatus).optional(), priority: z.nativeEnum(TicketPriority).optional(), tenantId: z.string().uuid().optional(), q: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters' });
    const { status, priority, tenantId, q, page, pageSize } = query.data;
    const where: Prisma.SupportTicketWhereInput = { ...(status ? { status } : {}), ...(priority ? { priority } : {}), ...(tenantId ? { tenantId } : {}), ...(q ? { OR: [{ subject: { contains: q, mode: 'insensitive' } }, { tenant: { name: { contains: q, mode: 'insensitive' } } }] } : {}) };
    const [items, total, counts] = await Promise.all([
      prisma.supportTicket.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { tenant: { select: { id: true, name: true } }, _count: { select: { messages: true } } } }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return res.json({ items, total, page, pageSize, counts: Object.fromEntries(counts.map(row => [row.status, row._count._all])) });
  } catch (error) { return next(error); }
});

supportAdminRoutes.get('/support/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { tenant: { select: { id: true, name: true, status: true } } } });
    if (!ticket) return res.status(404).json({ message: 'Chamado não encontrado' });
    const messages = await thread(ticket.id, true);
    const authors = await prisma.user.findMany({ where: { id: { in: [...new Set(messages.map(message => message.authorUserId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, name: true } });
    return res.json({ ticket, messages: messages.map(message => ({ ...message, author: authors.find(author => author.id === message.authorUserId)?.name ?? (message.fromAdmin ? 'RM Suporte' : 'Cliente') })) });
  } catch (error) { return next(error); }
});

supportAdminRoutes.post('/support/tickets/:id/messages', async (req, res, next) => {
  try {
    const input = z.object({ body: z.string().trim().min(2).max(4000), internal: z.boolean().default(false), status: z.nativeEnum(TicketStatus).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Escreva a mensagem' });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ message: 'Chamado não encontrado' });
    const nextStatus = input.data.status ?? (input.data.internal ? ticket.status : ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status);
    await prisma.$transaction([
      prisma.supportMessage.create({ data: { ticketId: ticket.id, authorUserId: req.auth!.userId, fromAdmin: true, internal: input.data.internal, body: input.data.body } }),
      prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: nextStatus, resolvedAt: nextStatus === 'RESOLVED' || nextStatus === 'CLOSED' ? ticket.resolvedAt ?? new Date() : null } }),
    ]);
    return res.status(201).json({ ok: true });
  } catch (error) { return next(error); }
});

supportAdminRoutes.patch('/support/tickets/:id', async (req, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(TicketStatus).optional(), priority: z.nativeEnum(TicketPriority).optional(), adminNotes: z.string().max(2000).nullable().optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed' });
    const current = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Chamado não encontrado' });
    const done = input.data.status === 'RESOLVED' || input.data.status === 'CLOSED';
    const updated = await prisma.supportTicket.update({ where: { id: current.id }, data: { ...input.data, ...(input.data.status ? { resolvedAt: done ? current.resolvedAt ?? new Date() : null } : {}) } });
    await audit(req, 'SAAS_SUPPORT_TICKET_UPDATED', 'SupportTicket', current.id, { before: { status: current.status, priority: current.priority }, after: { status: updated.status, priority: updated.priority } }, current.tenantId);
    return res.json(updated);
  } catch (error) { return next(error); }
});

// ---------- Leads captured by the public form and managed by the sales team ----------
export const leadPublicRoutes = Router();
leadPublicRoutes.use(rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Muitas solicitações. Tente novamente mais tarde.' } }));
leadPublicRoutes.post('/', async (req, res, next) => {
  try {
    const input = z.object({
      name: z.string().trim().min(2).max(120), company: z.string().trim().min(2).max(160), email: z.string().trim().email().max(160), phone: z.string().trim().min(8).max(30),
      city: z.string().trim().max(80).optional(), interest: z.string().trim().max(60).optional(), message: z.string().trim().max(1000).optional(), kind: z.enum(['DEMO', 'CONTACT', 'ONBOARDING']).default('DEMO'), website: z.string().max(0).optional(),
    }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Confira os dados informados', errors: input.error.flatten() });
    const { website: _honeypot, ...data } = input.data;
    const duplicate = await prisma.saaSLead.findFirst({ where: { email: data.email.toLowerCase(), kind: data.kind, status: { in: ['NEW', 'CONTACTED'] } }, select: { id: true } });
    if (!duplicate) await prisma.saaSLead.create({ data: { ...data, email: data.email.toLowerCase() } });
    return res.status(201).json({ ok: true });
  } catch (error) { return next(error); }
});

supportAdminRoutes.get('/leads', async (req, res, next) => {
  try {
    const query = z.object({ status: z.enum(['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST']).optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters' });
    const items = await prisma.saaSLead.findMany({ where: query.data.status ? { status: query.data.status } : {}, orderBy: { createdAt: 'desc' }, take: 300 });
    return res.json({ items });
  } catch (error) { return next(error); }
});

supportAdminRoutes.patch('/leads/:id', async (req, res, next) => {
  try {
    const input = z.object({ status: z.enum(['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST']).optional(), notes: z.string().max(2000).nullable().optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed' });
    const current = await prisma.saaSLead.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Interessado não encontrado' });
    const updated = await prisma.saaSLead.update({ where: { id: current.id }, data: input.data });
    await audit(req, 'SAAS_LEAD_UPDATED', 'SaaSLead', current.id, { before: current.status, after: updated.status });
    return res.json(updated);
  } catch (error) { return next(error); }
});
