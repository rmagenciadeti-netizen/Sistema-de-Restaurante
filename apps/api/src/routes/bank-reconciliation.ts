import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { matchStatement, parseOfx, parseStatementCsv } from '../lib/bank-statement';

// Bank reconciliation: compares an imported statement (OFX or CSV) with PAID financial entries and marks the confirmed ones as reconciled.
// Nothing is created or changed in the ledger itself, so no duplicate entries can appear.
export const bankReconciliationRoutes = Router();
bankReconciliationRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

const matchSchema = z.object({ format: z.enum(['OFX', 'CSV']), content: z.string().min(10).max(2_000_000), bankAccountId: z.string().uuid().optional(), toleranceDays: z.number().int().min(0).max(10).default(3) });

bankReconciliationRoutes.post('/match', async (req, res, next) => {
  try {
    const parsed = matchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const { bankAccountId, toleranceDays } = parsed.data;
    if (bankAccountId && !(await prisma.bankAccount.findFirst({ where: { id: bankAccountId, tenantId }, select: { id: true } }))) return res.status(404).json({ message: 'Bank account not found' });
    const lines = (parsed.data.format === 'OFX' ? parseOfx(parsed.data.content) : parseStatementCsv(parsed.data.content)).slice(0, 5000);
    if (lines.length === 0) return res.status(400).json({ message: 'Nenhum lançamento reconhecido no arquivo. Use OFX ou CSV com colunas data, descrição e valor.' });
    const days = lines.map(line => new Date(`${line.date}T12:00:00Z`).getTime());
    const from = new Date(Math.min(...days) - toleranceDays * 86_400_000 - 86_400_000); const to = new Date(Math.max(...days) + toleranceDays * 86_400_000 + 86_400_000);
    const rows = await prisma.financialEntry.findMany({
      where: { tenantId, status: 'PAID', reconciledAt: null, settledAt: { gte: from, lte: to }, ...(bankAccountId ? { bankAccountId } : {}) },
      select: { id: true, type: true, amount: true, paidAmount: true, settledAt: true, description: true }, orderBy: { settledAt: 'asc' }, take: 10_000,
    });
    const entries = rows.map(row => ({ id: row.id, type: row.type as 'INCOME' | 'EXPENSE', amount: Number(row.paidAmount) || Number(row.amount), date: row.settledAt!.toISOString().slice(0, 10), description: row.description }));
    const result = matchStatement(lines, entries, toleranceDays);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    return res.json({
      summary: { lines: lines.length, matched: result.matches.filter(match => match.entryId).length, unmatchedLines: result.matches.filter(match => !match.entryId).length, unmatchedEntries: result.unmatchedEntries.length },
      matches: result.matches.map(match => ({ ...match, entry: match.entryId ? byId.get(match.entryId) ?? null : null })),
      unmatchedEntries: result.unmatchedEntries,
    });
  } catch (error) { return next(error); }
});

bankReconciliationRoutes.post('/confirm', async (req, res, next) => {
  try {
    const parsed = z.object({ entryIds: z.array(z.string().uuid()).min(1).max(5000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const tenantId = req.auth!.tenantId!;
    const result = await prisma.financialEntry.updateMany({ where: { id: { in: parsed.data.entryIds }, tenantId, status: 'PAID', reconciledAt: null }, data: { reconciledAt: new Date() } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'BANK_RECONCILED', entityType: 'FinancialEntry', metadata: { count: result.count } } });
    return res.json({ reconciled: result.count });
  } catch (error) { return next(error); }
});
