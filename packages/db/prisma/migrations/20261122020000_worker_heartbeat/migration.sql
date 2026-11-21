-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "instance" TEXT NOT NULL,
    "commit" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "details" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

