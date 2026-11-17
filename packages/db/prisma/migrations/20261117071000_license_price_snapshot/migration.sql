-- AlterTable
ALTER TABLE "TenantLicense" ADD COLUMN     "activationFee" DECIMAL(12,2),
ADD COLUMN     "billingPeriod" "BillingPeriod",
ADD COLUMN     "contractedPrice" DECIMAL(12,2),
ADD COLUMN     "discountPercent" DECIMAL(5,2),
ADD COLUMN     "setupFee" DECIMAL(12,2);

