ALTER TABLE "Product"
ADD COLUMN "allowFractionalQuantity" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "OrderItem"
ALTER COLUMN "quantity" TYPE DECIMAL(12,3)
USING "quantity"::DECIMAL(12,3);
