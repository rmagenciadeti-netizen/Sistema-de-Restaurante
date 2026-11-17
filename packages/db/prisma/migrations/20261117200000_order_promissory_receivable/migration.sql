ALTER TABLE "FinancialEntry"
ADD COLUMN "orderId" TEXT,
ADD COLUMN "customerId" TEXT,
ADD COLUMN "debtorName" TEXT,
ADD COLUMN "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "FinancialEntry_orderId_key" ON "FinancialEntry"("orderId");
CREATE INDEX "FinancialEntry_tenantId_customerId_status_idx" ON "FinancialEntry"("tenantId", "customerId", "status");

ALTER TABLE "FinancialEntry"
ADD CONSTRAINT "FinancialEntry_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "FinancialEntry_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
