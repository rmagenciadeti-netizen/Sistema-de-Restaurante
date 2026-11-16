import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { tenantRoutes } from './routes/tenants';
import { dashboardRoutes } from './routes/dashboard';
import { employeeRoutes } from './routes/employees';
import { productRoutes } from './routes/products';
import { productionRoutes } from './routes/production';
import { orderRoutes } from './routes/orders';

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'rm-restaurant-api',
    version: '1.0.0',
    stack: 'monolith-modular',
    multiTenant: true,
    modules: ['master-admin', 'tenants', 'employees', 'orders', 'products', 'production'],
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1/modules', (_req, res) => {
  res.json({
    modules: [
      'master-admin',
      'companies',
      'units',
      'employees',
      'pos',
      'menu',
      'production',
      'inventory',
      'financial',
      'delivery',
      'crm',
      'reports',
      'audit',
    ],
  });
});

app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/production', productionRoutes);
app.use('/api/v1/orders', orderRoutes);

app.listen(PORT, () => {
  console.log(`RM Restaurant API running on http://localhost:${PORT}`);
});
