import { Router, Request, Response } from 'express';
import { z } from 'zod';

const productSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  sector: z.string().min(2),
  price: z.number().min(0),
  cost: z.number().min(0),
  stock: z.number().min(0).default(0),
  active: z.boolean().default(true),
});

const products = [
  {
    id: 'prod-1',
    name: 'Hambúrguer Clássico',
    category: 'Sanduíches',
    sector: 'Cozinha',
    price: 32.9,
    cost: 14.5,
    stock: 45,
    active: true,
    prepTimeMinutes: 12,
  },
  {
    id: 'prod-2',
    name: 'Pizza Margherita',
    category: 'Pizzas',
    sector: 'Pizzaria',
    price: 48.0,
    cost: 19.2,
    stock: 20,
    active: true,
    prepTimeMinutes: 18,
  },
  {
    id: 'prod-3',
    name: 'Açaí 500ml',
    category: 'Sobremesas',
    sector: 'Açaí',
    price: 26.0,
    cost: 9.8,
    stock: 35,
    active: true,
    prepTimeMinutes: 8,
  },
];

export const productRoutes = Router();

productRoutes.get('/', (_req: Request, res: Response) => {
  res.json({ total: products.length, items: products });
});

productRoutes.get('/:id', (req: Request, res: Response) => {
  const product = products.find((item) => item.id === req.params.id);
  if (!product) {
    return res.status(404).json({ message: 'Product not found.' });
  }
  return res.json(product);
});

productRoutes.post('/', (req: Request, res: Response) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  }

  const product = {
    id: `prod-${Date.now()}`,
    prepTimeMinutes: 10,
    ...parsed.data,
  };

  products.push(product);
  return res.status(201).json(product);
});

productRoutes.get('/summary/stock', (_req: Request, res: Response) => {
  const totalStock = products.reduce((sum, item) => sum + item.stock, 0);
  res.json({ totalStock, lowStock: products.filter((item) => item.stock < 10).length });
});
