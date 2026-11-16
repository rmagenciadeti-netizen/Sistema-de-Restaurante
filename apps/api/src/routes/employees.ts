import { Router, Request, Response } from 'express';
import { z } from 'zod';

const employeeSchema = z.object({
  fullName: z.string().min(2),
  cpf: z.string().optional(),
  role: z.string().min(2),
  sector: z.string().default('Operação'),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).default('ACTIVE'),
  commission: z.number().min(0).max(100).default(0),
});

const employees = [
  {
    id: 'emp-1',
    fullName: 'Maria Souza',
    cpf: '123.456.789-00',
    role: 'Gerente',
    sector: 'Administração',
    status: 'ACTIVE',
    commission: 7,
    permissions: ['visualizar', 'editar', 'consultar_relatorios', 'aprovar_comissoes'],
  },
  {
    id: 'emp-2',
    fullName: 'João Mendes',
    cpf: '111.222.333-44',
    role: 'Garçom',
    sector: 'Atendimento',
    status: 'ACTIVE',
    commission: 12,
    permissions: ['visualizar', 'abrir_comanda', 'transferir_mesa'],
  },
  {
    id: 'emp-3',
    fullName: 'Paula Rocha',
    cpf: '999.888.777-66',
    role: 'Cozinheira',
    sector: 'Cozinha',
    status: 'ACTIVE',
    commission: 5,
    permissions: ['visualizar', 'cancelar', 'consultar_relatorios'],
  },
];

export const employeeRoutes = Router();

employeeRoutes.get('/', (_req: Request, res: Response) => {
  res.json({ total: employees.length, items: employees });
});

employeeRoutes.get('/:id', (req: Request, res: Response) => {
  const employee = employees.find((item) => item.id === req.params.id);
  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }
  return res.json(employee);
});

employeeRoutes.post('/', (req: Request, res: Response) => {
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  }

  const employee = {
    id: `emp-${Date.now()}`,
    ...parsed.data,
    permissions: ['visualizar', 'criar', 'editar'],
  };

  employees.push(employee as typeof employees[number]);
  return res.status(201).json(employee);
});
