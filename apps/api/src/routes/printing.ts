import { Router } from 'express';
import { PrintJobKind, PrintJobStatus, PrinterKind } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, MANAGEMENT_ROLES, PRODUCTION_ROLES } from '../lib/permissions';
import { generateAgentToken, hashAgentToken } from '../lib/agent-auth';
import { enqueueProductionPrints, pickPrinter } from '../lib/print-queue';
import { paperColumns } from '../lib/ticket';

export const printingRoutes = Router();
printingRoutes.use(requireAuth, requireTenant, allowRead(PRODUCTION_ROLES, MANAGEMENT_ROLES));
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {});

const printerSchema = z.object({
  name: z.string().min(2).max(100),
  unitId: z.string().uuid().optional(),
  sectorId: z.string().uuid().nullable().optional(),
  kind: z.nativeEnum(PrinterKind).default(PrinterKind.KITCHEN),
  connectionType: z.enum(['NETWORK', 'USB', 'SHARED', 'SERIAL']),
  address: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  manufacturer: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).default(80),
  autoCut: z.boolean().default(true),
  cashDrawer: z.boolean().default(false),
  isPrimary: z.boolean().default(false),
  active: z.boolean().default(true),
});

async function validateRefs(tenantId: string, data: { unitId?: string | null; sectorId?: string | null }) {
  if (data.unitId && !await prisma.unit.findFirst({ where: { id: data.unitId, tenantId } })) return 'Unit does not belong to this tenant';
  if (data.sectorId && !await prisma.productionSector.findFirst({ where: { id: data.sectorId, tenantId } })) return 'Sector does not belong to this tenant';
  return null;
}

printingRoutes.get('/printers', async (req, res, next) => {
  try { const items = await prisma.printer.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req) }, include: { sector: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
printingRoutes.post('/printers', async (req, res, next) => {
  try {
    const parsed = printerSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    const refError = await validateRefs(tenantId, { unitId, sectorId: parsed.data.sectorId }); if (refError) return res.status(400).json({ message: refError });
    const printer = await prisma.$transaction(async tx => {
      if (parsed.data.isPrimary && parsed.data.sectorId) await tx.printer.updateMany({ where: { tenantId, sectorId: parsed.data.sectorId }, data: { isPrimary: false } });
      return tx.printer.create({ data: { ...parsed.data, tenantId, unitId } });
    });
    return res.status(201).json(printer);
  } catch (error) { return next(error); }
});
printingRoutes.patch('/printers/:id', async (req, res, next) => {
  try {
    const parsed = printerSchema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.printer.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) } }); if (!current) return res.status(404).json({ message: 'Printer not found' });
    const refError = await validateRefs(tenantId, { unitId: parsed.data.unitId, sectorId: parsed.data.sectorId }); if (refError) return res.status(400).json({ message: refError });
    const sectorId = parsed.data.sectorId === undefined ? current.sectorId : parsed.data.sectorId;
    const printer = await prisma.$transaction(async tx => {
      if (parsed.data.isPrimary && sectorId) await tx.printer.updateMany({ where: { tenantId, sectorId, id: { not: current.id } }, data: { isPrimary: false } });
      return tx.printer.update({ where: { id: current.id }, data: parsed.data });
    });
    return res.json(printer);
  } catch (error) { return next(error); }
});
printingRoutes.post('/printers/:id/test', async (req, res, next) => {
  try {
    const printer = await prisma.printer.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, active: true, ...unitScope(req) } }); if (!printer) return res.status(404).json({ message: 'Active printer not found' });
    const width = paperColumns(printer.paperWidthMm);
    const content = ['TESTE DE IMPRESSAO'.padStart(Math.floor((width + 18) / 2)), '-'.repeat(width), `Impressora: ${printer.name}`, `Papel: ${printer.paperWidthMm}mm`, '-'.repeat(width)].join('\n');
    const job = await prisma.printJob.create({ data: { tenantId: printer.tenantId, unitId: printer.unitId, printerId: printer.id, sectorId: printer.sectorId, kind: PrintJobKind.TEST, content } });
    return res.status(201).json(job);
  } catch (error) { return next(error); }
});

printingRoutes.get('/jobs', async (req, res, next) => {
  try {
    const status = z.nativeEnum(PrintJobStatus).safeParse(req.query.status);
    const items = await prisma.printJob.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req), ...(status.success ? { status: status.data } : {}) }, include: { printer: { select: { id: true, name: true } }, sector: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
printingRoutes.post('/jobs/:id/retry', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const job = await prisma.printJob.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req), status: { in: [PrintJobStatus.FAILED, PrintJobStatus.CANCELLED] } } }); if (!job) return res.status(404).json({ message: 'Retryable print job not found' });
    const sector = job.sectorId ? await prisma.productionSector.findFirst({ where: { id: job.sectorId, tenantId }, include: { printers: true } }) : null;
    const printer = sector ? pickPrinter(sector) : job.printerId ? await prisma.printer.findFirst({ where: { id: job.printerId, tenantId, active: true } }) : null;
    if (!printer) return res.status(409).json({ message: 'No active printer available for this job' });
    const updated = await prisma.printJob.update({ where: { id: job.id }, data: { printerId: printer.id, status: PrintJobStatus.PENDING, attempts: 0, error: null, claimedAt: null } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
printingRoutes.post('/orders/:orderId/print', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { items: { include: { product: true, modifiers: true } } } });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const jobs = await prisma.$transaction(tx => enqueueProductionPrints(tx, order, { onlyAutoPrint: false }));
    return res.status(201).json({ items: jobs, total: jobs.length });
  } catch (error) { return next(error); }
});

printingRoutes.get('/agents', async (req, res, next) => {
  try { const items = await prisma.printAgent.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req) }, select: { id: true, name: true, unitId: true, active: true, lastSeenAt: true, createdAt: true }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
printingRoutes.post('/agents', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().min(2).max(100), unitId: z.string().uuid().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const token = generateAgentToken();
    const agent = await prisma.printAgent.create({ data: { tenantId, unitId, name: parsed.data.name, tokenHash: hashAgentToken(token) }, select: { id: true, name: true, unitId: true, active: true } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'PRINT_AGENT_CREATED', entityType: 'PrintAgent', entityId: agent.id } });
    return res.status(201).json({ ...agent, token, note: 'Guarde o token agora; ele não será exibido novamente.' });
  } catch (error) { return next(error); }
});
printingRoutes.patch('/agents/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const current = await prisma.printAgent.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req) } }); if (!current) return res.status(404).json({ message: 'Agent not found' });
    const agent = await prisma.printAgent.update({ where: { id: current.id }, data: { active: parsed.data.active }, select: { id: true, name: true, active: true } });
    return res.json(agent);
  } catch (error) { return next(error); }
});
