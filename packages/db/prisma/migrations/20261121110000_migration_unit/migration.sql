-- AlterTable
ALTER TABLE "MigrationSession" ADD COLUMN     "unitId" TEXT;

-- AddForeignKey
ALTER TABLE "MigrationSession" ADD CONSTRAINT "MigrationSession_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

