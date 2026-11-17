-- CreateTable
CREATE TABLE "StoreImage" (
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreImage_pkey" PRIMARY KEY ("tenantId","kind")
);

-- AddForeignKey
ALTER TABLE "StoreImage" ADD CONSTRAINT "StoreImage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
