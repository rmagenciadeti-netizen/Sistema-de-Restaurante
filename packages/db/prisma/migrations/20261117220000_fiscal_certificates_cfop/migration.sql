-- DropIndex
DROP INDEX "FiscalNumbering_tenantId_kind_environment_key";

-- AlterTable
ALTER TABLE "FiscalNumbering" ADD COLUMN     "unitKey" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "FiscalSettings" ADD COLUMN     "certIssuer" TEXT,
ADD COLUMN     "certSerial" TEXT,
ADD COLUMN     "certType" TEXT NOT NULL DEFAULT 'A1',
ADD COLUMN     "cfop" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "OperationNature" ADD COLUMN     "destination" TEXT NOT NULL DEFAULT 'ANY',
ADD COLUMN     "operation" TEXT NOT NULL DEFAULT 'SALE',
ADD COLUMN     "taxRegime" TEXT,
ADD COLUMN     "taxRuleId" TEXT,
ADD COLUMN     "ufDestination" TEXT,
ADD COLUMN     "ufOrigin" TEXT;

-- AlterTable
ALTER TABLE "TaxRule" ADD COLUMN     "cfopInterstate" TEXT;

-- CreateTable
CREATE TABLE "FiscalUnitConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "issuer" JSONB NOT NULL DEFAULT '{}',
    "certType" TEXT NOT NULL DEFAULT 'A1',
    "certPfxEnc" TEXT,
    "certPasswordEnc" TEXT,
    "certSubject" TEXT,
    "certCnpj" TEXT,
    "certIssuer" TEXT,
    "certSerial" TEXT,
    "certValidFrom" TIMESTAMP(3),
    "certValidTo" TIMESTAMP(3),
    "certUploadedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalUnitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalUnitConfig_unitId_key" ON "FiscalUnitConfig"("unitId");

-- CreateIndex
CREATE INDEX "FiscalUnitConfig_tenantId_idx" ON "FiscalUnitConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalNumbering_tenantId_unitKey_kind_environment_key" ON "FiscalNumbering"("tenantId", "unitKey", "kind", "environment");

-- AddForeignKey
ALTER TABLE "FiscalUnitConfig" ADD CONSTRAINT "FiscalUnitConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalUnitConfig" ADD CONSTRAINT "FiscalUnitConfig_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationNature" ADD CONSTRAINT "OperationNature_taxRuleId_fkey" FOREIGN KEY ("taxRuleId") REFERENCES "TaxRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

