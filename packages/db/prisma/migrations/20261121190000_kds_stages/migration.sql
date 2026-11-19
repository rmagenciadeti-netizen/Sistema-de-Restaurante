-- Custom KDS stage of an item (refines OrderItem.status); nullable, so existing rows are untouched.
ALTER TABLE "OrderItem" ADD COLUMN "kdsStage" TEXT;
