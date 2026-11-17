-- AlterTable
ALTER TABLE "PrintAgent" ADD COLUMN     "printers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "printersReportedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Printer" ADD COLUMN     "agentId" TEXT;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "PrintAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
