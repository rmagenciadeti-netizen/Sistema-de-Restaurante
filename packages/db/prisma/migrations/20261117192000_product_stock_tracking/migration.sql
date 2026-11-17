CREATE TYPE "ProductStockMovementType" AS ENUM (
  'PURCHASE',
  'ADJUSTMENT',
  'WASTE',
  'ORDER_CONSUMPTION',
  'ORDER_REVERSAL'
);

ALTER TABLE "Product"
ADD COLUMN "stockControlled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "stockQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0;

CREATE TABLE "ProductStockMovement" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "unitId" TEXT,
  "productId" TEXT NOT NULL,
  "type" "ProductStockMovementType" NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "actorUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductStockMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductStockMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductStockMovement_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ProductStockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProductStockMovement_tenantId_unitId_createdAt_idx" ON "ProductStockMovement"("tenantId", "unitId", "createdAt");
CREATE INDEX "ProductStockMovement_productId_createdAt_idx" ON "ProductStockMovement"("productId", "createdAt");
CREATE INDEX "ProductStockMovement_tenantId_reference_type_idx" ON "ProductStockMovement"("tenantId", "reference", "type");
