ALTER TABLE "User"
ADD COLUMN "username" TEXT,
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
