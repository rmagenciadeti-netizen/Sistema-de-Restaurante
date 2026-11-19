-- CreateTable
CREATE TABLE "MigrationSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT,
    "label" TEXT NOT NULL,
    "sourceSystem" TEXT,
    "sourceUnknown" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "outcome" TEXT,
    "engineVersion" TEXT NOT NULL,
    "analysis" JSONB,
    "mapping" JSONB,
    "summary" JSONB,
    "validation" JSONB,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationFile" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "content" BYTEA,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRecord" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "sourceKey" TEXT,
    "status" TEXT NOT NULL,
    "original" JSONB NOT NULL,
    "normalized" JSONB,
    "corrections" JSONB,
    "issues" JSONB,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "targetId" TEXT,
    "targetCreated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationMappingTemplate" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationMappingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationSession_tenantId_createdAt_idx" ON "MigrationSession"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "MigrationSession_tenantId_status_idx" ON "MigrationSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MigrationFile_tenantId_sessionId_idx" ON "MigrationFile"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationFile_sessionId_sha256_key" ON "MigrationFile"("sessionId", "sha256");

-- CreateIndex
CREATE INDEX "MigrationRecord_sessionId_entity_status_idx" ON "MigrationRecord"("sessionId", "entity", "status");

-- CreateIndex
CREATE INDEX "MigrationRecord_tenantId_targetId_idx" ON "MigrationRecord"("tenantId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRecord_sessionId_tableName_rowIndex_key" ON "MigrationRecord"("sessionId", "tableName", "rowIndex");

-- CreateIndex
CREATE INDEX "MigrationEvent_sessionId_createdAt_idx" ON "MigrationEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationMappingTemplate_signature_entity_key" ON "MigrationMappingTemplate"("signature", "entity");

-- AddForeignKey
ALTER TABLE "MigrationSession" ADD CONSTRAINT "MigrationSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationFile" ADD CONSTRAINT "MigrationFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationFile" ADD CONSTRAINT "MigrationFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRecord" ADD CONSTRAINT "MigrationRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRecord" ADD CONSTRAINT "MigrationRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationEvent" ADD CONSTRAINT "MigrationEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MigrationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationEvent" ADD CONSTRAINT "MigrationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one migration may be executing per restaurant at any time.
CREATE UNIQUE INDEX "MigrationSession_tenantId_running_key" ON "MigrationSession"("tenantId") WHERE "status" = 'RUNNING';

