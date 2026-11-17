import { Router } from 'express';
import { PrintJobStatus } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { requireAgent } from '../lib/agent-auth';

export const MAX_PRINT_ATTEMPTS = 3;
export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

export const printAgentRoutes = Router();
printAgentRoutes.use(requireAgent);

// Claims pending jobs. A job stuck in PRINTING past the timeout (agent crashed) becomes claimable again.
printAgentRoutes.get('/jobs/next', async (req, res, next) => {
  try {
    const { agentId, tenantId, unitId } = req.agent!;
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    const unitScope = unitId ? { AND: [{ OR: [{ unitId }, { unitId: null }] }] } : {};
    await prisma.printJob.updateMany({
      where: { tenantId, ...unitScope, status: PrintJobStatus.PRINTING, claimedAt: { lt: staleBefore }, attempts: { gte: MAX_PRINT_ATTEMPTS } },
      data: { status: PrintJobStatus.FAILED, error: 'CLAIM_TIMED_OUT', claimedAt: null, claimedByAgentId: null, claimId: null },
    });
    const claimable = { OR: [{ status: PrintJobStatus.PENDING }, { status: PrintJobStatus.PRINTING, claimedAt: { lt: staleBefore } }] };
    const candidates = await prisma.printJob.findMany({
      where: { tenantId, printerId: { not: null }, attempts: { lt: MAX_PRINT_ATTEMPTS }, ...unitScope, ...claimable },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
    });
    const items = [];
    for (const { id } of candidates) {
      const claimId = randomUUID();
      const claimed = await prisma.printJob.updateMany({ where: { id, tenantId, attempts: { lt: MAX_PRINT_ATTEMPTS }, ...unitScope, ...claimable }, data: { status: PrintJobStatus.PRINTING, claimedAt: new Date(), claimedByAgentId: agentId, claimId, attempts: { increment: 1 } } });
      if (claimed.count !== 1) continue;
      const job = await prisma.printJob.findUnique({ where: { id }, include: { printer: true } });
      if (!job?.printer) continue;
      const { printer } = job;
      items.push({ id: job.id, claimId, kind: job.kind, content: job.content, attempts: job.attempts, printer: { connectionType: printer.connectionType, address: printer.address, port: printer.port, paperWidthMm: printer.paperWidthMm, autoCut: printer.autoCut, cashDrawer: printer.cashDrawer } });
    }
    return res.json({ items });
  } catch (error) { return next(error); }
});

printAgentRoutes.post('/jobs/:id/result', async (req, res, next) => {
  try {
    const parsed = z.object({ claimId: z.string().uuid(), attempt: z.number().int().min(1), ok: z.boolean(), error: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const { tenantId, agentId, unitId } = req.agent!;
    const status = parsed.data.ok ? PrintJobStatus.PRINTED : parsed.data.attempt >= MAX_PRINT_ATTEMPTS ? PrintJobStatus.FAILED : PrintJobStatus.PENDING;
    const updated = await prisma.printJob.updateMany({
      where: { id: req.params.id, tenantId, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}), status: PrintJobStatus.PRINTING, claimedByAgentId: agentId, claimId: parsed.data.claimId, attempts: parsed.data.attempt },
      data: { status, error: parsed.data.ok ? null : parsed.data.error ?? 'PRINT_FAILED', printedAt: parsed.data.ok ? new Date() : null, claimedAt: null, claimedByAgentId: null, claimId: null },
    });
    if (updated.count !== 1) return res.status(404).json({ message: 'Active print claim not found' });
    return res.json({ id: req.params.id, status });
  } catch (error) { return next(error); }
});
