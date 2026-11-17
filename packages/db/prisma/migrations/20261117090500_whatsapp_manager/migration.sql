-- CreateTable
CREATE TABLE "WhatsappManager" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "pid" INTEGER,
    "host" TEXT,

    CONSTRAINT "WhatsappManager_pkey" PRIMARY KEY ("id")
);

