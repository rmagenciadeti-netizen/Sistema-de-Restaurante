-- AlterTable
ALTER TABLE "FinancialEntry" ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommissionClosing" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionClosing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionClosing_tenantId_createdAt_idx" ON "CommissionClosing"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "CommissionClosing" ADD CONSTRAINT "CommissionClosing_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

