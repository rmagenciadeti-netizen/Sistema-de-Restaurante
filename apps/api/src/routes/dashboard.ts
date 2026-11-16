import { Router, Request, Response } from 'express';

export const dashboardRoutes = Router();

dashboardRoutes.get('/master', (_req: Request, res: Response) => {
  res.json({
    summary: {
      totalCompanies: 248,
      activeCompanies: 194,
      suspendedCompanies: 18,
      trialCompanies: 36,
      mrr: 89240.5,
      arr: 1058886,
      overdue: 12650,
      newRegistrations: 32,
      openTickets: 14,
    },
    plans: [
      { name: 'Básico', count: 92, revenue: 21480 },
      { name: 'Profissional', count: 81, revenue: 28050 },
      { name: 'Premium', count: 54, revenue: 24500 },
      { name: 'Enterprise', count: 21, revenue: 15210 },
    ],
    modules: [
      { name: 'PDV', usage: 97 },
      { name: 'Delivery', usage: 88 },
      { name: 'Produção', usage: 76 },
      { name: 'Fiscal', usage: 69 },
      { name: 'WhatsApp', usage: 82 },
      { name: 'Financeiro', usage: 91 },
    ],
    infra: {
      databaseSizeGb: 96,
      storageGb: 214,
      storageUsedPct: 64,
      apiErrors: 7,
      failedIntegrations: 3,
      queueMessages: 1420,
    },
  });
});
