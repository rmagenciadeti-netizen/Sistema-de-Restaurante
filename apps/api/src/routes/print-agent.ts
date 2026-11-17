import { Router } from 'express';
import { PrintJobStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAgent } from '../lib/agent-auth';

export const MAX_PRINT_ATTEMPTS = 3;
export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

export const printAgentRoutes = Router();
printAgentRoutes.use(requireAgent);

// Claims pending jobs. A job stuck in PRINTING past the timeout (agent crashed) becomes claimable again.
printAgentRoutes.get('/jobs/next', async (req, res, next) => {
  try {
    const { tenantId, unitId } = req.agent!;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    const claimable = { OR: [{ status: PrintJobStatus.PENDING }, { status: PrintJobStatus.PRINTING, claimedAt: { lt: staleBefore } }] };
    const candidates = await prisma.printJob.findMany({
      where: { tenantId, printerId: { not: null }, ...(unitId ? { AND: [{ OR: [{ unitId }, { unitId: null }] }] } : {}), ...claimable },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
    });
    const items = [];
    for (const { id } of candidates) {
      const claimed = await prisma.printJob.updateMany({ where: { id, tenantId, ...claimable }, data: { status: PrintJobStatus.PRINTING, claimedAt: new Date(), attempts: { increment: 1 } } });
      if (claimed.count !== 1) continue;
      const job = await prisma.printJob.findUnique({ where: { id }, include: { printer: true } });
      if (!job?.printer) continue;
      const { printer } = job;
      items.push({ id: job.id, kind: job.kind, content: job.content, attempts: job.attempts, printer: { connectionType: printer.connectionType, address: printer.address, port: printer.port, paperWidthMm: printer.paperWidthMm, autoCut: printer.autoCut, cashDrawer: printer.cashDrawer } });
    }
    return res.json({ items });
  } catch (error) { return next(error); }
});

printAgentRoutes.post('/jobs/:id/result', async (req, res, next) => {
  try {
    const parsed = z.object({ ok: z.boolean(), error: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const { tenantId } = req.agent!;
    const job = await prisma.printJob.findFirst({ where: { id: req.params.id, tenantId, status: PrintJobStatus.PRINTING } }); if (!job) return res.status(404).json({ message: 'Job in printing state not found' });
    const status = parsed.data.ok ? PrintJobStatus.PRINTED : job.attempts >= MAX_PRINT_ATTEMPTS ? PrintJobStatus.FAILED : PrintJobStatus.PENDING;
    const updated = await prisma.printJob.update({ where: { id: job.id }, data: { status, error: parsed.data.ok ? null : parsed.data.error ?? 'PRINT_FAILED', printedAt: parsed.data.ok ? new Date() : null, claimedAt: null } });
    return res.json({ id: updated.id, status: updated.status });
  } catch (error) { return next(error); }
});
