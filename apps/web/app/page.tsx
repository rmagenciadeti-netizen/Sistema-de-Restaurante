import { Router, Request, Response } from 'express';

export const orderRoutes = Router();

const orders = [
  {
    id: 'ord-1',
    code: 'A-104',
    channel: 'POS',
    status: 'OPEN',
    table: 8,
    items: [
      { name: 'Hambúrguer Clássico', quantity: 2, price: 32.9 },
      { name: 'Refrigerante', quantity: 2, price: 8.5 },
    ],
    subtotal: 82.6,
    serviceFee: 8.26,
    total: 90.86,
  },
  {
    id: 'ord-2',
    code: 'D-220',
    channel: 'DELIVERY',
    status: 'PREPARING',
    table: null,
    items: [
      { name: 'Pizza Margherita', quantity: 1, price: 48.0 },
      { name: 'Açaí 500ml', quantity: 1, price: 26.0 },
    ],
    subtotal: 74.0,
    serviceFee: 7.4,
    total: 81.4,
  },
  {
    id: 'ord-3',
    code: 'T-010',
    channel: 'TABLE',
    status: 'READY',
    table: 5,
    items: [
      { name: 'Açaí 500ml', quantity: 2, price: 26.0 },
    ],
    subtotal: 52.0,
    serviceFee: 5.2,
    total: 57.2,
  },
];

orderRoutes.get('/', (_req: Request, res: Response) => {
  res.json({ total: orders.length, items: orders });
});

orderRoutes.get('/summary', (_req: Request, res: Response) => {
  const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);
  const revenueByChannel = {
    POS: orders.filter((o) => o.channel === 'POS').reduce((sum, o) => sum + o.total, 0),
    DELIVERY: orders.filter((o) => o.channel === 'DELIVERY').reduce((sum, o) => sum + o.total, 0),
    TABLE: orders.filter((o) => o.channel === 'TABLE').reduce((sum, o) => sum + o.total, 0),
  };

  res.json({
    totalRevenue,
    openOrders: orders.filter((order) => order.status === 'OPEN').length,
    preparingOrders: orders.filter((order) => order.status === 'PREPARING').length,
    readyOrders: orders.filter((order) => order.status === 'READY').length,
    revenueByChannel,
  });
});

orderRoutes.post('/', (req: Request, res: Response) => {
  const order = {
    id: `ord-${Date.now()}`,
    ...req.body,
    status: req.body.status || 'OPEN',
    serviceFee: Number(req.body.serviceFee || 0),
    total: Number(req.body.total || 0),
  };

  orders.push(order);
  return res.status(201).json(order);
});
