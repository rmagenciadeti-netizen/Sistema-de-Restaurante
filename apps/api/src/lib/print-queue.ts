import { PrintJobKind, PrintJobStatus, Prisma } from '@prisma/client';
import { renderProductionTicket, type TicketItem } from './ticket';

export type PrintableOrder = {
  id: string;
  code: string;
  tenantId: string;
  unitId: string | null;
  channel: string;
  tableLabel: string | null;
  customerName: string | null;
  createdAt: Date;
  items: Array<{ quantity: number; weightKg?: Prisma.Decimal | null; notes: string | null; sectorId: string | null; status?: string; product: { name: string }; modifiers?: Array<{ name: string; quantity: number; sectorId: string | null }> }>;
};

type SectorWithPrinters = Prisma.ProductionSectorGetPayload<{ include: { printers: true } }>;

export function sectorMatchesUnit(sector: { unitId: string | null }, unitId: string | null) {
  return sector.unitId === null || sector.unitId === unitId;
}

export function pickPrinter(sector: SectorWithPrinters, unitId: string | null) {
  if (!sectorMatchesUnit(sector, unitId)) return null;
  const active = sector.printers.filter(printer => printer.active && printer.tenantId === sector.tenantId);
  const local = unitId ? active.filter(printer => printer.unitId === unitId) : [];
  const shared = active.filter(printer => printer.unitId === null);
  return local.find(printer => printer.isPrimary) ?? local[0] ?? shared.find(printer => printer.isPrimary) ?? shared[0] ?? null;
}

// Creates one print job per production sector. Sectors without an active printer produce a FAILED job that can be retried after configuration.
export async function enqueueProductionPrints(tx: Prisma.TransactionClient, order: PrintableOrder, options: { onlyAutoPrint: boolean }) {
  const live = order.items.filter(item => item.status !== 'CANCELLED');
  const sectorIds = [...new Set(live.flatMap(item => [item.sectorId, ...(item.modifiers ?? []).map(modifier => modifier.sectorId)]).filter((id): id is string => Boolean(id)))];
  if (sectorIds.length === 0) return [];
  const sectors = await tx.productionSector.findMany({
    where: { id: { in: sectorIds }, tenantId: order.tenantId, active: true, ...(options.onlyAutoPrint ? { autoPrint: true } : {}) },
    include: { printers: true },
  });
  const jobs = [];
  for (const sector of sectors) {
    const compatible = sectorMatchesUnit(sector, order.unitId);
    const printer = pickPrinter(sector, order.unitId);
    // Modifiers print under their item unless they have their own sector (e.g. a topping prepared at another station).
    const lines: TicketItem[] = [];
    for (const item of live) {
      const mods = item.modifiers ?? [];
      const inline = mods.filter(modifier => modifier.sectorId === null || modifier.sectorId === item.sectorId);
      if (item.sectorId === sector.id) lines.push({ quantity: item.quantity, name: item.weightKg ? `${item.product.name} (${item.weightKg.toFixed(3)} kg)` : item.product.name, notes: item.notes, extras: inline.map(modifier => `${modifier.quantity}x ${modifier.name}`) });
      for (const modifier of mods.filter(candidate => candidate.sectorId === sector.id && candidate.sectorId !== item.sectorId)) lines.push({ quantity: modifier.quantity * item.quantity, name: modifier.name, notes: `para ${item.product.name}` });
    }
    const content = renderProductionTicket({
      title: sector.name,
      orderCode: order.code,
      channel: order.channel,
      tableLabel: order.tableLabel,
      customerName: order.customerName,
      createdAt: order.createdAt,
      items: lines,
    }, printer?.paperWidthMm);
    jobs.push(await tx.printJob.create({
      data: {
        tenantId: order.tenantId,
        unitId: order.unitId,
        orderId: order.id,
        sectorId: sector.id,
        printerId: printer?.id,
        kind: PrintJobKind.PRODUCTION,
        content,
        status: printer ? PrintJobStatus.PENDING : PrintJobStatus.FAILED,
        error: printer ? null : compatible ? 'NO_ACTIVE_PRINTER_FOR_SECTOR' : 'SECTOR_NOT_AVAILABLE_FOR_UNIT',
      },
    }));
  }
  return jobs;
}
