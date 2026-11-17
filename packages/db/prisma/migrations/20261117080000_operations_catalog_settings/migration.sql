-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "cest" TEXT,
ADD COLUMN     "favorite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ncm" TEXT,
ADD COLUMN     "scaleCode" INTEGER,
ADD COLUMN     "scaleDepartment" INTEGER,
ADD COLUMN     "scaleNotes" TEXT,
ADD COLUMN     "sendToScale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shelfLifeDays" INTEGER,
ADD COLUMN     "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxRuleId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "couvertFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "number" INTEGER,
ADD COLUMN     "releaseAt" TIMESTAMP(3),
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "weightKg" DECIMAL(10,3);

-- AlterTable
ALTER TABLE "DeliveryJob" ADD COLUMN     "courierId" TEXT;

-- CreateTable
CREATE TABLE "TenantSettings" (
    "tenantId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "adminPasswordHash" TEXT,
    "orderCounter" INTEGER NOT NULL DEFAULT 0,
    "orderCounterDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Courier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Carrier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethodConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "equivalent" "PaymentMethod" NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "showLocal" BOOLEAN NOT NULL DEFAULT true,
    "showStore" BOOLEAN NOT NULL DEFAULT true,
    "showApp" BOOLEAN NOT NULL DEFAULT true,
    "allowChange" BOOLEAN NOT NULL DEFAULT false,
    "requireDocument" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethodConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "FinancialEntryType" NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DiscountType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionProduct" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PromotionProduct_pkey" PRIMARY KEY ("promotionId","productId")
);

-- CreateTable
CREATE TABLE "CategorySchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "CategorySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordRelease" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "action" TEXT NOT NULL,
    "orderId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ncm" TEXT,
    "cest" TEXT,
    "origin" INTEGER NOT NULL DEFAULT 0,
    "cfop" TEXT,
    "icmsCst" TEXT,
    "icmsRate" DECIMAL(6,3),
    "icmsReduction" DECIMAL(6,3),
    "pisCst" TEXT,
    "pisRate" DECIMAL(6,3),
    "cofinsCst" TEXT,
    "cofinsRate" DECIMAL(6,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Courier_tenantId_active_idx" ON "Courier"("tenantId", "active");

-- CreateIndex
CREATE INDEX "Carrier_tenantId_active_idx" ON "Carrier"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethodConfig_tenantId_name_key" ON "PaymentMethodConfig"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialCategory_tenantId_type_name_key" ON "FinancialCategory"("tenantId", "type", "name");

-- CreateIndex
CREATE INDEX "Promotion_tenantId_active_startsAt_idx" ON "Promotion"("tenantId", "active", "startsAt");

-- CreateIndex
CREATE INDEX "PromotionProduct_productId_idx" ON "PromotionProduct"("productId");

-- CreateIndex
CREATE INDEX "CategorySchedule_tenantId_categoryId_idx" ON "CategorySchedule"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "CoverEvent_tenantId_active_startsAt_idx" ON "CoverEvent"("tenantId", "active", "startsAt");

-- CreateIndex
CREATE INDEX "PasswordRelease_tenantId_createdAt_idx" ON "PasswordRelease"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRule_tenantId_name_key" ON "TaxRule"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_scaleCode_key" ON "Product"("tenantId", "scaleCode");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxRuleId_fkey" FOREIGN KEY ("taxRuleId") REFERENCES "TaxRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryJob" ADD CONSTRAINT "DeliveryJob_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Courier" ADD CONSTRAINT "Courier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Carrier" ADD CONSTRAINT "Carrier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethodConfig" ADD CONSTRAINT "PaymentMethodConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialCategory" ADD CONSTRAINT "FinancialCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySchedule" ADD CONSTRAINT "CategorySchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorySchedule" ADD CONSTRAINT "CategorySchedule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverEvent" ADD CONSTRAINT "CoverEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordRelease" ADD CONSTRAINT "PasswordRelease_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

