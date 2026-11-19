-- CreateEnum
CREATE TYPE "InventoryScope" AS ENUM ('FULL', 'PARTIAL', 'CATEGORY');

-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WasteReason" AS ENUM ('EXPIRED', 'DAMAGED', 'PRODUCTION', 'OTHER');

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "category" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "maximumStock" DECIMAL(14,3);

-- AlterTable
ALTER TABLE "PurchaseItem" ADD COLUMN     "receivedQuantity" DECIMAL(14,3),
ADD COLUMN     "receivedUnitCost" DECIMAL(12,4);

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "receiptNote" TEXT,
ADD COLUMN     "receivedById" TEXT,
ADD COLUMN     "receivedInvoiceId" TEXT,
ADD COLUMN     "receivedTotal" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "reason" "WasteReason";

-- CreateTable
CREATE TABLE "InventoryCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "title" TEXT NOT NULL,
    "scope" "InventoryScope" NOT NULL,
    "category" TEXT,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "startedById" TEXT NOT NULL,
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "expected" DECIMAL(14,3) NOT NULL,
    "counted" DECIMAL(14,3),
    "adjustment" DECIMAL(14,3),
    "unitCost" DECIMAL(12,4) NOT NULL,
    "note" TEXT,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryCount_tenantId_unitId_status_createdAt_idx" ON "InventoryCount"("tenantId", "unitId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryCountLine_ingredientId_idx" ON "InventoryCountLine"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountLine_countId_ingredientId_key" ON "InventoryCountLine"("countId", "ingredientId");

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

