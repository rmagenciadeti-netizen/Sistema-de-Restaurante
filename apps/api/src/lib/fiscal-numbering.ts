import { FiscalEnvironment, FiscalKind, Prisma } from '@prisma/client';

// Reserves the next sequential number of the tenant's current series for one environment (homologation and production never share numbers).
// Must run in the same transaction that stores the document, so a failed insert gives the number back. The UPDATE ... increment is atomic,
// which keeps concurrent emissions from repeating a number.
export async function reserveFiscalNumber(tx: Prisma.TransactionClient, tenantId: string, kind: FiscalKind, environment: FiscalEnvironment = FiscalEnvironment.PRODUCTION): Promise<{ series: string; number: string }> {
  await tx.fiscalNumbering.createMany({ data: [{ tenantId, kind, environment }], skipDuplicates: true });
  const row = await tx.fiscalNumbering.update({ where: { tenantId_kind_environment: { tenantId, kind, environment } }, data: { nextNumber: { increment: 1 } } });
  return { series: row.series, number: String(row.nextNumber - 1) };
}

export async function loadFiscalNumbering(db: Pick<Prisma.TransactionClient, 'fiscalNumbering'>, tenantId: string, environment: FiscalEnvironment = FiscalEnvironment.PRODUCTION) {
  const rows = await db.fiscalNumbering.findMany({ where: { tenantId, environment } });
  return Object.values(FiscalKind).map(kind => {
    const row = rows.find(item => item.kind === kind);
    return { kind, series: row?.series ?? '1', nextNumber: row?.nextNumber ?? 1 };
  });
}
