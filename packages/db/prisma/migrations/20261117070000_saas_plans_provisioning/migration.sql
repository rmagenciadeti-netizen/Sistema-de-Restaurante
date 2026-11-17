-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('WAITING', 'PROCESSING', 'COMPLETED', 'ERROR', 'NEEDS_INTERVENTION');

-- AlterTable
ALTER TABLE "TenantLicense" ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "SaaSPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "maxUnits" INTEGER,
    "maxUsers" INTEGER,
    "activationFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "setupFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanModule" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,

    CONSTRAINT "PlanModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantProvisioning" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'WAITING',
    "step" TEXT NOT NULL DEFAULT 'RECEIVED',
    "completedSteps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantProvisioning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaaSPlan_key_key" ON "SaaSPlan"("key");

-- CreateIndex
CREATE INDEX "SaaSPlan_active_name_idx" ON "SaaSPlan"("active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PlanModule_planId_moduleKey_key" ON "PlanModule"("planId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_planId_period_key" ON "PlanPrice"("planId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProvisioning_tenantId_key" ON "TenantProvisioning"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProvisioning_idempotencyKey_key" ON "TenantProvisioning"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TenantProvisioning_status_updatedAt_idx" ON "TenantProvisioning"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "PlanModule" ADD CONSTRAINT "PlanModule_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantLicense" ADD CONSTRAINT "TenantLicense_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantProvisioning" ADD CONSTRAINT "TenantProvisioning_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

