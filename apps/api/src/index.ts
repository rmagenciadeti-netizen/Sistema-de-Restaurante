import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { authRoutes } from './routes/auth';
import { tenantRoutes } from './routes/tenants';
import { dashboardRoutes } from './routes/dashboard';
import { employeeRoutes } from './routes/employees';
import { productRoutes } from './routes/products';
import { productionRoutes } from './routes/production';
import { orderRoutes } from './routes/orders';
import { unitRoutes } from './routes/units';
import { inventoryRoutes } from './routes/inventory';
import { cashRoutes } from './routes/cash';
import { deliveryRoutes } from './routes/delivery';
import { whatsappRoutes } from './routes/whatsapp';
import { financialRoutes } from './routes/financial';
import { reportsRoutes } from './routes/reports';

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
export function parseAllowedOrigins(config: string | undefined): string[] {
  const origins = (config ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let valid = false;
    try { const url = new URL(origin); valid = ['http:', 'https:'].includes(url.protocol) && url.origin === origin; } catch { /* Invalid origin. */ }
    if (!valid) throw new Error('CORS_ORIGIN must contain exact HTTP(S) origins');
  }
  return origins;
}
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);
app.use(cors({ origin: (origin, callback) => { if (!origin || allowedOrigins.includes(origin)) return callback(null, true); return callback(new OriginNotAllowedError()); } }));
app.use('/api/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many requests. Try again later.' } }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'rm-restaurant-api', version: '1.0.0' }));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/units', unitRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/production', productionRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/cash', cashRoutes);
app.use('/api/v1/delivery', deliveryRoutes);
app.use('/api/v1/whatsapp', whatsappRoutes);
app.use('/api/v1/financial', financialRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof OriginNotAllowedError) return res.status(403).json({ message: 'Origin not allowed' });
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
    if (error.type === 'entity.too.large') return res.status(413).json({ message: 'JSON body too large' });
  }
  console.error(error);
  return res.status(500).json({ message: 'Internal server error' });
});

class OriginNotAllowedError extends Error {}

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`RM Restaurant API listening on port ${port}`));
}
