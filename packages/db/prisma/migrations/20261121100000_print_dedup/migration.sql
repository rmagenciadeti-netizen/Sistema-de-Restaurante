-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "dedupKey" TEXT;


-- A receipt original is queued once per (company, key); reprints have no key. Hand-written: Prisma cannot model partial unique indexes.
CREATE UNIQUE INDEX "PrintJob_tenantId_dedupKey_key" ON "PrintJob"("tenantId", "dedupKey") WHERE "dedupKey" IS NOT NULL;
