-- CreateTable
CREATE TABLE "ProductUnitPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductUnitPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductUnitPrice_tenantId_unitId_idx" ON "ProductUnitPrice"("tenantId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnitPrice_productId_unitId_key" ON "ProductUnitPrice"("productId", "unitId");

-- AddForeignKey
ALTER TABLE "ProductUnitPrice" ADD CONSTRAINT "ProductUnitPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnitPrice" ADD CONSTRAINT "ProductUnitPrice_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnitPrice" ADD CONSTRAINT "ProductUnitPrice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

