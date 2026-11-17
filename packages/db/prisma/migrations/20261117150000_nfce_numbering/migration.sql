-- AlterTable
ALTER TABLE "FiscalDocument" ADD COLUMN     "series" TEXT;

-- CreateTable
CREATE TABLE "FiscalNumbering" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "FiscalKind" NOT NULL DEFAULT 'NFCE',
    "series" TEXT NOT NULL DEFAULT '1',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalNumbering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalNumbering_tenantId_kind_key" ON "FiscalNumbering"("tenantId", "kind");

-- AddForeignKey
ALTER TABLE "FiscalNumbering" ADD CONSTRAINT "FiscalNumbering_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
