-- AlterTable
ALTER TABLE "WhatsappConversation" ADD COLUMN     "agentMemory" JSONB;

-- CreateTable
CREATE TABLE "WhatsappAgentAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "tool" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "args" JSONB,
    "result" JSONB,
    "summary" TEXT,
    "dedupeKey" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappAgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsappAgentAction_tenantId_createdAt_idx" ON "WhatsappAgentAction"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappAgentAction_conversationId_createdAt_idx" ON "WhatsappAgentAction"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappAgentAction_tenantId_conversationId_dedupeKey_key" ON "WhatsappAgentAction"("tenantId", "conversationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "WhatsappAgentAction" ADD CONSTRAINT "WhatsappAgentAction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappAgentAction" ADD CONSTRAINT "WhatsappAgentAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsappConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

