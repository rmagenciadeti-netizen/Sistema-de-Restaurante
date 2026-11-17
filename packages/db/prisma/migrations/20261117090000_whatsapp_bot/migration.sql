-- CreateTable
CREATE TABLE "WhatsappSession" (
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "desired" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "qr" TEXT,
    "phone" TEXT,
    "pushName" TEXT,
    "lastError" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSession_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "WhatsappConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "customerId" TEXT,
    "handoff" BOOLEAN NOT NULL DEFAULT false,
    "handoffUntil" TIMESTAMP(3),
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT,
    "stateData" JSONB,
    "lastGreetingAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappChatMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappAutoMessage" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT NOT NULL,

    CONSTRAINT "WhatsappAutoMessage_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "WhatsappKnowledge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" TEXT[],
    "answer" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappUnanswered" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappUnanswered_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsappConversation_tenantId_lastMessageAt_idx" ON "WhatsappConversation"("tenantId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConversation_tenantId_jid_key" ON "WhatsappConversation"("tenantId", "jid");

-- CreateIndex
CREATE INDEX "WhatsappChatMessage_conversationId_createdAt_idx" ON "WhatsappChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappChatMessage_tenantId_createdAt_idx" ON "WhatsappChatMessage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappKnowledge_tenantId_active_idx" ON "WhatsappKnowledge"("tenantId", "active");

-- CreateIndex
CREATE INDEX "WhatsappUnanswered_tenantId_lastAskedAt_idx" ON "WhatsappUnanswered"("tenantId", "lastAskedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappUnanswered_tenantId_text_key" ON "WhatsappUnanswered"("tenantId", "text");

-- AddForeignKey
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappChatMessage" ADD CONSTRAINT "WhatsappChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsappConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappAutoMessage" ADD CONSTRAINT "WhatsappAutoMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappKnowledge" ADD CONSTRAINT "WhatsappKnowledge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappUnanswered" ADD CONSTRAINT "WhatsappUnanswered_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

