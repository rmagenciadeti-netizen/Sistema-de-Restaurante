import { Ingredient, OrderStatus, Prisma, ProductStockMovementType, StockMovementType } from '@prisma/client';

type RecipeOrder = {
  id: string;
  code: string;
  tenantId: string;
  unitId: string | null;
  items: Array<{
    quantity: number | Prisma.Decimal;
    weightKg?: Prisma.Decimal | null;
    modifiers?: Array<{ quantity: number; ingredientId: string | null; ingredientQuantity: Prisma.Decimal | null }>;
    product: {
      id: string;
      tenantId: string;
      recipe: {
        tenantId: string;
        productId: string;
        yield: Prisma.Decimal;
        ingredients: Array<{
          quantity: Prisma.Decimal;
          ingredient: Ingredient;
        }>;
      } | null;
    };
  }>;
};

const MAX_STOCK_QUANTITY = new Prisma.Decimal('99999999999.999');
const MAX_PRODUCT_STOCK = new Prisma.Decimal('999999999.999');

type ProductStockOrder = {
  id: string;
  code: string;
  tenantId: string;
  unitId: string | null;
  items: Array<{
    quantity: number | Prisma.Decimal;
    parentItemId?: string | null;
    product: { id: string; tenantId: string; unitId: string | null; stockControlled: boolean };
  }>;
};

export async function consumeOrderProductStock(tx: Prisma.TransactionClient, order: ProductStockOrder, actorUserId: string | null): Promise<void> {
  const requiredByProduct = new Map<string, { product: ProductStockOrder['items'][number]['product']; quantity: Prisma.Decimal }>();
  for (const item of order.items) {
    if (item.parentItemId || !item.product.stockControlled) continue;
    const visibleToOrderUnit = order.unitId === null ? item.product.unitId === null : item.product.unitId === null || item.product.unitId === order.unitId;
    const quantity = new Prisma.Decimal(item.quantity);
    if (item.product.tenantId !== order.tenantId || !visibleToOrderUnit || !quantity.gt(0)) throw new OrderInventoryError('INVALID_PRODUCT_STOCK');
    const total = (requiredByProduct.get(item.product.id)?.quantity ?? new Prisma.Decimal(0)).add(quantity);
    if (total.gt(MAX_PRODUCT_STOCK)) throw new OrderInventoryError('INVALID_PRODUCT_STOCK');
    requiredByProduct.set(item.product.id, { product: item.product, quantity: total });
  }

  for (const { product, quantity } of requiredByProduct.values()) {
    const updated = await tx.product.updateMany({
      where: { id: product.id, tenantId: order.tenantId, unitId: product.unitId, stockControlled: true, stockQuantity: { gte: quantity } },
      data: { stockQuantity: { decrement: quantity } },
    });
    if (updated.count !== 1) throw new OrderInventoryError('INSUFFICIENT_STOCK');
    await tx.productStockMovement.create({
      data: { tenantId: order.tenantId, unitId: product.unitId, productId: product.id, type: ProductStockMovementType.ORDER_CONSUMPTION, quantity: quantity.negated(), reference: order.id, note: `Product stock reserved for order ${order.code}`, actorUserId },
    });
  }
}

export async function reverseOrderProductStock(tx: Prisma.TransactionClient, order: { id: string; code: string; tenantId: string }, actorUserId: string): Promise<void> {
  const movements = await tx.productStockMovement.findMany({
    where: { tenantId: order.tenantId, reference: order.id, type: { in: [ProductStockMovementType.ORDER_CONSUMPTION, ProductStockMovementType.ORDER_REVERSAL] } },
  });
  const net = new Map<string, { quantity: Prisma.Decimal; unitId: string | null }>();
  for (const movement of movements) {
    const entry = net.get(movement.productId) ?? { quantity: new Prisma.Decimal(0), unitId: movement.unitId };
    net.set(movement.productId, { quantity: entry.quantity.add(movement.quantity), unitId: entry.unitId });
  }
  for (const [productId, { quantity, unitId }] of net) {
    if (!quantity.lt(0)) continue;
    const restore = quantity.negated();
    const updated = await tx.product.updateMany({
      where: { id: productId, tenantId: order.tenantId },
      data: { stockQuantity: { increment: restore } },
    });
    if (updated.count !== 1) throw new OrderInventoryError('INVALID_PRODUCT_STOCK');
    await tx.productStockMovement.create({
      data: { tenantId: order.tenantId, unitId, productId, type: ProductStockMovementType.ORDER_REVERSAL, quantity: restore, reference: order.id, note: `Stock returned for cancelled or edited order ${order.code}`, actorUserId },
    });
  }
}

export class OrderInventoryError extends Error {
  constructor(readonly reason: 'INSUFFICIENT_STOCK' | 'INVALID_RECIPE' | 'INVALID_PRODUCT_STOCK') {
    super(reason);
  }
}

export async function consumeOrderInventory(
  tx: Prisma.TransactionClient,
  order: RecipeOrder,
  actorUserId: string,
): Promise<void> {
  const requiredByIngredient = new Map<string, { ingredient: Ingredient; quantity: Prisma.Decimal }>();

  for (const item of order.items) {
    const recipe = item.product.recipe;
    if (!recipe) continue;
    if (item.product.tenantId !== order.tenantId || recipe.tenantId !== order.tenantId || recipe.productId !== item.product.id || !recipe.yield.gt(0)) {
      throw new OrderInventoryError('INVALID_RECIPE');
    }

    for (const line of recipe.ingredients) {
      const { ingredient } = line;
      const visibleToOrderUnit = order.unitId === null
        ? ingredient.unitId === null
        : ingredient.unitId === null || ingredient.unitId === order.unitId;
      if (ingredient.tenantId !== order.tenantId || !ingredient.active || !visibleToOrderUnit || !line.quantity.gt(0)) {
        throw new OrderInventoryError('INVALID_RECIPE');
      }

      // For weighed products the recipe describes one kilo.
      const units = item.weightKg ? item.weightKg.mul(item.quantity) : new Prisma.Decimal(item.quantity);
      const quantity = line.quantity.mul(units).div(recipe.yield).toDecimalPlaces(3, Prisma.Decimal.ROUND_UP);
      const existing = requiredByIngredient.get(ingredient.id);
      const total = (existing?.quantity ?? new Prisma.Decimal(0)).add(quantity);
      if (total.gt(MAX_STOCK_QUANTITY)) throw new OrderInventoryError('INVALID_RECIPE');
      requiredByIngredient.set(ingredient.id, { ingredient, quantity: total });
    }
  }

  // Modifier options may consume their own ingredient (e.g. extra cheese); the amount is snapshotted on the order line.
  const modifierNeeds = new Map<string, Prisma.Decimal>();
  for (const item of order.items) {
    for (const modifier of item.modifiers ?? []) {
      if (!modifier.ingredientId || !modifier.ingredientQuantity) continue;
      const quantity = modifier.ingredientQuantity.mul(modifier.quantity).mul(item.quantity).toDecimalPlaces(3, Prisma.Decimal.ROUND_UP);
      modifierNeeds.set(modifier.ingredientId, (modifierNeeds.get(modifier.ingredientId) ?? new Prisma.Decimal(0)).add(quantity));
    }
  }
  if (modifierNeeds.size > 0) {
    const ingredients = await tx.ingredient.findMany({ where: { id: { in: [...modifierNeeds.keys()] }, tenantId: order.tenantId } });
    for (const ingredient of ingredients) {
      const visible = order.unitId === null ? ingredient.unitId === null : ingredient.unitId === null || ingredient.unitId === order.unitId;
      if (!ingredient.active || !visible) throw new OrderInventoryError('INVALID_RECIPE');
      const existing = requiredByIngredient.get(ingredient.id);
      const total = (existing?.quantity ?? new Prisma.Decimal(0)).add(modifierNeeds.get(ingredient.id)!);
      if (total.gt(MAX_STOCK_QUANTITY)) throw new OrderInventoryError('INVALID_RECIPE');
      requiredByIngredient.set(ingredient.id, { ingredient, quantity: total });
    }
    if (ingredients.length !== modifierNeeds.size) throw new OrderInventoryError('INVALID_RECIPE');
  }

  for (const { ingredient, quantity } of requiredByIngredient.values()) {
    const updated = await tx.ingredient.updateMany({
      where: {
        id: ingredient.id,
        tenantId: order.tenantId,
        unitId: ingredient.unitId,
        active: true,
        currentStock: { gte: quantity },
      },
      data: { currentStock: { decrement: quantity } },
    });
    if (updated.count !== 1) throw new OrderInventoryError('INSUFFICIENT_STOCK');

    await tx.stockMovement.create({
      data: {
        tenantId: order.tenantId,
        unitId: ingredient.unitId,
        ingredientId: ingredient.id,
        type: StockMovementType.ORDER_CONSUMPTION,
        quantity: quantity.negated(),
        reference: order.id,
        note: `Recipe consumption for order ${order.code}`,
        actorUserId,
      },
    });
  }
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.OPEN]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
    [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
    [OrderStatus.READY]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
    [OrderStatus.COMPLETED]: [],
    [OrderStatus.CANCELLED]: [],
  };
  return transitions[from].includes(to);
}

// Returns to stock what the order consumed when it started preparing. Safe to call once per cancelled order.
export async function reverseOrderInventory(tx: Prisma.TransactionClient, order: { id: string; code: string; tenantId: string }, actorUserId: string): Promise<void> {
  const consumed = await tx.stockMovement.findMany({ where: { tenantId: order.tenantId, reference: order.id, type: { in: [StockMovementType.ORDER_CONSUMPTION, StockMovementType.ORDER_REVERSAL] } } });
  const net = new Map<string, { quantity: Prisma.Decimal; unitId: string | null }>();
  for (const movement of consumed) {
    const entry = net.get(movement.ingredientId) ?? { quantity: new Prisma.Decimal(0), unitId: movement.unitId };
    net.set(movement.ingredientId, { quantity: entry.quantity.add(movement.quantity), unitId: entry.unitId });
  }
  for (const [ingredientId, { quantity, unitId }] of net) {
    if (!quantity.lt(0)) continue;
    const restore = quantity.negated();
    await tx.ingredient.updateMany({ where: { id: ingredientId, tenantId: order.tenantId }, data: { currentStock: { increment: restore } } });
    await tx.stockMovement.create({ data: { tenantId: order.tenantId, unitId, ingredientId, type: StockMovementType.ORDER_REVERSAL, quantity: restore, reference: order.id, note: `Reversal for cancelled order ${order.code}`, actorUserId } });
  }
}
