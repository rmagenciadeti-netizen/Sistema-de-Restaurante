-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "gtin" TEXT,
ADD COLUMN     "isComponent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "localOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "measureUnit" TEXT NOT NULL DEFAULT 'UN';
