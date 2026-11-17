import { FiscalEnvironment, FiscalKind, Prisma } from '@prisma/client';

// Reserves the next sequential number of the tenant's current series for one environment (homologation and production never share numbers).
// Must run in the same transaction that stores the document, so a failed insert gives the number back. The UPDATE ... increment is atomic,
// which keeps concurrent emissions from repeating a number.
export async function fiscalUnitKey(db: Pick<Prisma.TransactionClient, 'fiscalUnitConfig' | 'fiscalSettings'>, tenantId: string, unitId: string | null): Promise<string> {
  if (!unitId) return '';
  const config = await db.fiscalUnitConfig.findFirst({ where: { tenantId, unitId }, select: { issuer: true } });
  if (!config) return '';
  const settings = await db.fiscalSettings.findUnique({ where: { tenantId }, select: { issuer: true } });
  const unitCnpj = (config.issuer as { cnpj?: string } | null)?.cnpj?.replace(/\D/g, '');
  const companyCnpj = (settings?.issuer as { cnpj?: string } | null)?.cnpj?.replace(/\D/g, '');
  return unitCnpj && unitCnpj !== companyCnpj ? unitId : '';
}

export async function independentFiscalUnitIds(db: Pick<Prisma.TransactionClient, 'fiscalUnitConfig' | 'fiscalSettings'>, tenantId: string): Promise<string[]> {
  const [settings, units] = await Promise.all([
    db.fiscalSettings.findUnique({ where: { tenantId }, select: { issuer: true } }),
    db.fiscalUnitConfig.findMany({ where: { tenantId }, select: { unitId: true, issuer: true } }),
  ]);
  const companyCnpj = (settings?.issuer as { cnpj?: string } | null)?.cnpj?.replace(/\D/g, '') ?? '';
  return units.filter(unit => {
    const unitCnpj = (unit.issuer as { cnpj?: string } | null)?.cnpj?.replace(/\D/g, '');
    return Boolean(unitCnpj && unitCnpj !== companyCnpj);
  }).map(unit => unit.unitId);
}

export async function reserveFiscalNumber(tx: Prisma.TransactionClient, tenantId: string, kind: FiscalKind, environment: FiscalEnvironment = FiscalEnvironment.PRODUCTION, unitKey = ''): Promise<{ series: string; number: string }> {
  await tx.fiscalNumbering.createMany({ data: [{ tenantId, kind, environment, unitKey }], skipDuplicates: true });
  const row = await tx.fiscalNumbering.update({ where: { tenantId_unitKey_kind_environment: { tenantId, unitKey, kind, environment } }, data: { nextNumber: { increment: 1 } } });
  return { series: row.series, number: String(row.nextNumber - 1) };
}

export async function loadFiscalNumbering(db: Pick<Prisma.TransactionClient, 'fiscalNumbering'>, tenantId: string, environment: FiscalEnvironment = FiscalEnvironment.PRODUCTION, unitKey = '') {
  const rows = await db.fiscalNumbering.findMany({ where: { tenantId, environment, unitKey } });
  return Object.values(FiscalKind).map(kind => {
    const row = rows.find(item => item.kind === kind);
    return { kind, series: row?.series ?? '1', nextNumber: row?.nextNumber ?? 1 };
  });
}
