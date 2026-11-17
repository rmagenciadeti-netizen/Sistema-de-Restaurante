-- CreateEnum
CREATE TYPE "FiscalEnvironment" AS ENUM ('HOMOLOGATION', 'PRODUCTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FiscalStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "FiscalStatus" ADD VALUE 'CONTINGENCY';
ALTER TYPE "FiscalStatus" ADD VALUE 'DENIED';

-- DropIndex
DROP INDEX "FiscalNumbering_tenantId_kind_key";

-- AlterTable
ALTER TABLE "FiscalDocument" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contingency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contingencyAt" TIMESTAMP(3),
ADD COLUMN     "environment" "FiscalEnvironment" NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN     "issuedById" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "protocol" TEXT,
ADD COLUMN     "statusCode" TEXT,
ADD COLUMN     "xml" TEXT;

-- AlterTable
ALTER TABLE "FiscalNumbering" ADD COLUMN     "environment" "FiscalEnvironment" NOT NULL DEFAULT 'PRODUCTION';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fiscalDecidedAt" TIMESTAMP(3),
ADD COLUMN     "fiscalDecidedById" TEXT,
ADD COLUMN     "fiscalMode" TEXT;

-- AlterTable
ALTER TABLE "TaxRule" ADD COLUMN     "cBenef" TEXT,
ADD COLUMN     "cClassTrib" TEXT,
ADD COLUMN     "cbsRate" DECIMAL(6,3),
ADD COLUMN     "fcpRate" DECIMAL(6,3),
ADD COLUMN     "fcpStRate" DECIMAL(6,3),
ADD COLUMN     "ibsCbsCst" TEXT,
ADD COLUMN     "ibsMunRate" DECIMAL(6,3),
ADD COLUMN     "ibsUfRate" DECIMAL(6,3),
ADD COLUMN     "icmsStMva" DECIMAL(6,3),
ADD COLUMN     "icmsStRate" DECIMAL(6,3),
ADD COLUMN     "icmsStReduction" DECIMAL(6,3),
ADD COLUMN     "ipiCst" TEXT,
ADD COLUMN     "ipiEnquadramento" TEXT,
ADD COLUMN     "ipiRate" DECIMAL(6,3),
ADD COLUMN     "isRate" DECIMAL(6,3),
ADD COLUMN     "validFrom" TIMESTAMP(3),
ADD COLUMN     "validTo" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FiscalSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environment" "FiscalEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
    "provider" TEXT,
    "providerTokenEnc" TEXT,
    "issuer" JSONB NOT NULL DEFAULT '{}',
    "nfe" JSONB NOT NULL DEFAULT '{}',
    "nfce" JSONB NOT NULL DEFAULT '{}',
    "cscId" TEXT,
    "cscTokenEnc" TEXT,
    "certPfxEnc" TEXT,
    "certPasswordEnc" TEXT,
    "certSubject" TEXT,
    "certCnpj" TEXT,
    "certValidFrom" TIMESTAMP(3),
    "certValidTo" TIMESTAMP(3),
    "certUploadedAt" TIMESTAMP(3),
    "pdvMode" TEXT NOT NULL DEFAULT 'NON_FISCAL',
    "defaultTaxRuleId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "documentId" TEXT,
    "environment" "FiscalEnvironment" NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "kind" "FiscalKind",
    "series" TEXT,
    "numberFrom" INTEGER,
    "numberTo" INTEGER,
    "sequence" INTEGER,
    "justification" TEXT,
    "protocol" TEXT,
    "message" TEXT,
    "xml" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalSettings_tenantId_key" ON "FiscalSettings"("tenantId");

-- CreateIndex
CREATE INDEX "FiscalEvent_tenantId_type_createdAt_idx" ON "FiscalEvent"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "FiscalEvent_documentId_createdAt_idx" ON "FiscalEvent"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "FiscalDocument_tenantId_environment_createdAt_idx" ON "FiscalDocument"("tenantId", "environment", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalNumbering_tenantId_kind_environment_key" ON "FiscalNumbering"("tenantId", "kind", "environment");

-- AddForeignKey
ALTER TABLE "FiscalSettings" ADD CONSTRAINT "FiscalSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalSettings" ADD CONSTRAINT "FiscalSettings_defaultTaxRuleId_fkey" FOREIGN KEY ("defaultTaxRuleId") REFERENCES "TaxRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalEvent" ADD CONSTRAINT "FiscalEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalEvent" ADD CONSTRAINT "FiscalEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FiscalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
