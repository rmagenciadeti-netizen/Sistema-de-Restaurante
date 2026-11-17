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
import { printingRoutes } from './routes/printing';
import { printAgentRoutes } from './routes/print-agent';
import { tableRoutes } from './routes/tables';
import { publicRoutes } from './routes/public';
import { customerRoutes } from './routes/customers';
import { purchasingRoutes } from './routes/purchasing';
import { couponRoutes } from './routes/coupons';
import { reservationRoutes } from './routes/reservations';
import { catalogRoutes } from './routes/catalog';
import { userRoutes } from './routes/users';
import { shiftRoutes } from './routes/shifts';
import { paymentRoutes, paymentWebhookRoutes } from './routes/payments';
import { fiscalRoutes } from './routes/fiscal';
import { inboundRoutes, integrationRoutes } from './routes/integrations';
import { registerProviders } from './providers.config';

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
const limiterMessage = { message: 'Too many requests. Try again later.' };
const printAgentPaths = '/print-agent';
const machinePaths = ['/print-agent', '/public', '/inbound', '/payments/webhook'];
// The print agent polls continuously from the restaurant network, so it has its own budget instead of the shared API one.
app.use('/api/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage, skip: req => machinePaths.some(prefix => req.path.startsWith(prefix)) }));
app.use(`/api/v1${printAgentPaths}`, rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/inbound', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/payments/webhook', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/public', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
// Webhook signatures are verified over the exact bytes received, so this path must bypass JSON parsing.
app.use('/api/v1/payments/webhook', express.raw({ type: () => true, limit: '256kb' }), paymentWebhookRoutes);
app.use(express.json({ limit: '1mb' }));
registerProviders();
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
app.use('/api/v1/printing', printingRoutes);
app.use('/api/v1/print-agent', printAgentRoutes);
app.use('/api/v1/tables', tableRoutes);
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/purchasing', purchasingRoutes);
app.use('/api/v1/coupons', couponRoutes);
app.use('/api/v1/reservations', reservationRoutes);
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/shifts', shiftRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/fiscal', fiscalRoutes);
app.use('/api/v1/integrations', integrationRoutes);
app.use('/api/v1/inbound', inboundRoutes);
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
