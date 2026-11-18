-- Optional personal visual preference (mode, primary color, sidebar color); the restaurant default lives in TenantSettings.
ALTER TABLE "User" ADD COLUMN "appearance" JSONB;
