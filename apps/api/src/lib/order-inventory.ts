import { Ingredient, OrderStatus, Prisma, StockMovementType } from '@prisma/client';

type RecipeOrder = {
  id: string;
  code: string;
  tenantId: string;
  unitId: string | null;
  items: Array<{
    quantity: number;
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

export class OrderInventoryError extends Error {
  constructor(readonly reason: 'INSUFFICIENT_STOCK' | 'INVALID_RECIPE') {
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

      const quantity = line.quantity.mul(item.quantity).div(recipe.yield).toDecimalPlaces(3, Prisma.Decimal.ROUND_UP);
      const existing = requiredByIngredient.get(ingredient.id);
      const total = (existing?.quantity ?? new Prisma.Decimal(0)).add(quantity);
      if (total.gt(MAX_STOCK_QUANTITY)) throw new OrderInventoryError('INVALID_RECIPE');
      requiredByIngredient.set(ingredient.id, { ingredient, quantity: total });
    }
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
