-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('SALE_PERCENT', 'PRODUCT_PERCENT', 'GOAL_BONUS');

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CommissionKind" NOT NULL,
    "userId" TEXT,
    "role" TEXT,
    "productId" TEXT,
    "percent" DECIMAL(5,2),
    "goalAmount" DECIMAL(12,2),
    "bonusAmount" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionRule_tenantId_active_idx" ON "CommissionRule"("tenantId", "active");

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

