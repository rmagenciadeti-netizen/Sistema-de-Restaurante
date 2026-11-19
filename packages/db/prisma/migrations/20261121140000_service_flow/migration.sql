-- CreateEnum
CREATE TYPE "TableRequestType" AS ENUM ('WAITER', 'BILL');

-- CreateEnum
CREATE TYPE "TableRequestStatus" AS ENUM ('OPEN', 'DONE');

-- AlterEnum
ALTER TYPE "OrderItemStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "Courier" ADD COLUMN     "commissionPercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "DeliveryJob" ADD COLUMN     "payout" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "DeliveryZone" ADD COLUMN     "neighborhoods" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "priority" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TableRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "type" "TableRequestType" NOT NULL,
    "status" "TableRequestStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,

    CONSTRAINT "TableRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableRequest_tenantId_unitId_status_createdAt_idx" ON "TableRequest"("tenantId", "unitId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TableRequest_tableId_type_status_idx" ON "TableRequest"("tableId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_clientRequestId_key" ON "Order"("tenantId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "TableRequest" ADD CONSTRAINT "TableRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableRequest" ADD CONSTRAINT "TableRequest_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

