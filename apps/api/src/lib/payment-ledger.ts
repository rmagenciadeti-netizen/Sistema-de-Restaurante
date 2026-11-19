import { PaymentStatus, Prisma } from '@prisma/client';

// Keeps the promissory (fiado) financial entry of an order in line with its confirmed payments. Shared by manual payments, refunds and TEF so the books follow one rule.
export async function syncPromissory(tx: Prisma.TransactionClient, tenantId: string, orderId: string, mode: 'payment' | 'refund') {
  const promissory = await tx.financialEntry.findUnique({ where: { orderId } });
  if (!promissory || promissory.status === 'CANCELLED') return;
  const received = await tx.payment.aggregate({ where: { tenantId, orderId, status: PaymentStatus.CONFIRMED, paidAt: { gte: promissory.createdAt } }, _sum: { amount: true } });
  const paidAmount = received._sum.amount ?? new Prisma.Decimal(0);
  const settled = paidAmount.gte(promissory.amount);
  await tx.financialEntry.update({
    where: { id: promissory.id },
    data: { paidAmount: paidAmount.gt(promissory.amount) ? promissory.amount : paidAmount, status: settled ? 'PAID' : 'OPEN', settledAt: settled ? (mode === 'refund' ? promissory.settledAt ?? new Date() : new Date()) : null },
  });
}
