-- CreateTable
CREATE TABLE "OperationNature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cfop" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUT',
    "finality" TEXT NOT NULL DEFAULT 'NORMAL',
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationNature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CstCorrelation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outCst" TEXT NOT NULL,
    "inCst" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CstCorrelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "accessKey" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT '1',
    "supplierName" TEXT NOT NULL,
    "supplierDocument" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "natureId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "xml" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "enteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalContingency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startedById" TEXT NOT NULL,
    "endedById" TEXT,

    CONSTRAINT "FiscalContingency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationNature_tenantId_name_key" ON "OperationNature"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CstCorrelation_tenantId_outCst_key" ON "CstCorrelation"("tenantId", "outCst");

-- CreateIndex
CREATE INDEX "ReceivedInvoice_tenantId_status_issuedAt_idx" ON "ReceivedInvoice"("tenantId", "status", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivedInvoice_tenantId_accessKey_key" ON "ReceivedInvoice"("tenantId", "accessKey");

-- CreateIndex
CREATE INDEX "FiscalContingency_tenantId_endedAt_idx" ON "FiscalContingency"("tenantId", "endedAt");

-- AddForeignKey
ALTER TABLE "OperationNature" ADD CONSTRAINT "OperationNature_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CstCorrelation" ADD CONSTRAINT "CstCorrelation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedInvoice" ADD CONSTRAINT "ReceivedInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedInvoice" ADD CONSTRAINT "ReceivedInvoice_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedInvoice" ADD CONSTRAINT "ReceivedInvoice_natureId_fkey" FOREIGN KEY ("natureId") REFERENCES "OperationNature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalContingency" ADD CONSTRAINT "FiscalContingency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
