import { Router, Request, Response } from 'express';

export const productionRoutes = Router();

const sectors = [
  {
    id: 'sec-1',
    name: 'Cozinha',
    code: 'CK',
    autoPrint: true,
    status: 'ACTIVE',
    color: '#ef4444',
    responsible: 'Chef',
  },
  {
    id: 'sec-2',
    name: 'Pizzaria',
    code: 'PZ',
    autoPrint: true,
    status: 'ACTIVE',
    color: '#f59e0b',
    responsible: 'Pizzaiolo',
  },
  {
    id: 'sec-3',
    name: 'Bar',
    code: 'BR',
    autoPrint: true,
    status: 'ACTIVE',
    color: '#10b981',
    responsible: 'Barman',
  },
  {
    id: 'sec-4',
    name: 'Expedição',
    code: 'EX',
    autoPrint: false,
    status: 'ACTIVE',
    color: '#3b82f6',
    responsible: 'Expedidor',
  },
];

const kdsQueue = [
  { id: 'kds-1', item: 'Hambúrguer Clássico', sector: 'Cozinha', status: 'Em preparo', table: 8 },
  { id: 'kds-2', item: 'Pizza Margherita', sector: 'Pizzaria', status: 'Pronto', table: 5 },
  { id: 'kds-3', item: 'Açaí 500ml', sector: 'Açaí', status: 'Em preparo', table: 12 },
];

productionRoutes.get('/sectors', (_req: Request, res: Response) => {
  res.json({ total: sectors.length, items: sectors });
});

productionRoutes.get('/kds', (_req: Request, res: Response) => {
  res.json({ items: kdsQueue, total: kdsQueue.length });
});

productionRoutes.post('/sectors', (req: Request, res: Response) => {
  const sector = {
    id: `sec-${Date.now()}`,
    ...req.body,
    status: req.body.status || 'ACTIVE',
    autoPrint: Boolean(req.body.autoPrint),
  };

  sectors.push(sector);
  return res.status(201).json(sector);
});
