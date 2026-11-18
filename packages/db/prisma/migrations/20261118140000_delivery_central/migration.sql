-- Estimated delivery time per zone and per-delivery payment for couriers (RM Delivery).
ALTER TABLE "DeliveryZone" ADD COLUMN "estimatedMinutes" INTEGER;
ALTER TABLE "Courier" ADD COLUMN "paymentPerDelivery" DECIMAL(12,2);
