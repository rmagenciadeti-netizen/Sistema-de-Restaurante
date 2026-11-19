-- CreateEnum
CREATE TYPE "TefStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'TIMEOUT', 'UNKNOWN', 'ERROR', 'REVERSED');

-- CreateEnum
CREATE TYPE "TefIntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'AWAITING_CREDENTIALS', 'CONFIGURED', 'IN_TESTING', 'HOMOLOGATED', 'PRODUCTION_ENABLED', 'FAILED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "acquirerCnpj" TEXT,
ADD COLUMN     "authorizationCode" TEXT,
ADD COLUMN     "cardBrand" TEXT,
ADD COLUMN     "installments" INTEGER,
ADD COLUMN     "integrated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nsu" TEXT,
ADD COLUMN     "pixEndToEnd" TEXT,
ADD COLUMN     "terminalId" TEXT;

-- CreateTable
CREATE TABLE "TefProviderConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'HOMOLOGATION',
    "integrationStatus" "TefIntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "establishmentCnpj" TEXT,
    "merchantCode" TEXT,
    "logicalNumber" TEXT,
    "terminalId" TEXT,
    "cashRegisterId" TEXT,
    "pinpad" TEXT,
    "connection" JSONB,
    "credentialsEnc" TEXT,
    "printing" JSONB,
    "enabledMethods" TEXT[],
    "acceptedBrands" TEXT[],
    "financialMapping" JSONB,
    "homologationEvidence" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TefProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TefTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "orderId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "provider" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "status" "TefStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "providerRef" TEXT,
    "nsu" TEXT,
    "authorizationCode" TEXT,
    "cardBrand" TEXT,
    "acquirerCnpj" TEXT,
    "pixEndToEnd" TEXT,
    "terminalId" TEXT,
    "responseCode" TEXT,
    "responseMessage" TEXT,
    "paymentId" TEXT,
    "operatorUserId" TEXT,
    "reversalRef" TEXT,
    "reversalReason" TEXT,
    "reversedByUserId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TefTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TefEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "fromStatus" "TefStatus",
    "toStatus" "TefStatus" NOT NULL,
    "note" TEXT,
    "payload" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TefEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TefProviderConfig_tenantId_provider_key" ON "TefProviderConfig"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "TefTransaction_paymentId_key" ON "TefTransaction"("paymentId");

-- CreateIndex
CREATE INDEX "TefTransaction_tenantId_status_createdAt_idx" ON "TefTransaction"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TefTransaction_tenantId_orderId_idx" ON "TefTransaction"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "TefTransaction_tenantId_idempotencyKey_key" ON "TefTransaction"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TefEvent_transactionId_createdAt_idx" ON "TefEvent"("transactionId", "createdAt");

-- AddForeignKey
ALTER TABLE "TefProviderConfig" ADD CONSTRAINT "TefProviderConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TefTransaction" ADD CONSTRAINT "TefTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TefTransaction" ADD CONSTRAINT "TefTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TefEvent" ADD CONSTRAINT "TefEvent_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "TefTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A provider NSU identifies one acquirer transaction: the same NSU can never be recorded twice for a company.
CREATE UNIQUE INDEX "TefTransaction_tenant_provider_nsu_key" ON "TefTransaction"("tenantId", "provider", "nsu") WHERE "nsu" IS NOT NULL;
