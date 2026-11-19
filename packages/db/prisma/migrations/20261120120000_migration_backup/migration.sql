-- CreateTable
CREATE TABLE "MigrationBackup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "stage" TEXT,
    "fileKey" TEXT,
    "fileSize" INTEGER,
    "sha256" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "database" JSONB NOT NULL,
    "manifest" JSONB,
    "verification" JSONB,
    "error" TEXT,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "MigrationBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationBackup_tenantId_sessionId_createdAt_idx" ON "MigrationBackup"("tenantId", "sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "MigrationBackup" ADD CONSTRAINT "MigrationBackup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationBackup" ADD CONSTRAINT "MigrationBackup_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
