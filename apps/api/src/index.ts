import './lib/env';
import { assertProductionEnv } from './lib/env-check';
import { ensureModuleCatalogOnce } from './lib/module-catalog';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { sessionRateKey } from './middleware/auth';
import { authRoutes } from './routes/auth';
import { prisma } from './lib/prisma';
import { WhatsappSessionManager, whatsappSessionsMode } from './lib/whatsapp-sessions';
import { scaleRoutes } from './routes/scale';
import { migrationRoutes } from './routes/migrations';
import { promotionRoutes } from './routes/promotions';
import { categoryScheduleRoutes } from './routes/category-schedules';
import { productToolsRoutes } from './routes/product-tools';
import { settingsRoutes } from './routes/settings';
import { appearanceRoutes } from './routes/appearance';
import { releaseRoutes } from './routes/releases';
import { courierRoutes } from './routes/couriers';
import { carrierRoutes } from './routes/carriers';
import { paymentMethodRoutes } from './routes/payment-methods';
import { financialCategoryRoutes } from './routes/financial-categories';
import { coverEventRoutes } from './routes/cover-events';
import { taxRuleRoutes } from './routes/tax-rules';
import { reportsExtraRoutes } from './routes/reports-extra';
import { storeRoutes } from './routes/store';
import { tenantRoutes } from './routes/tenants';
import { planRoutes } from './routes/plans';
import { commercialRoutes } from './routes/commercial';
import { intelligenceRoutes } from './routes/intelligence';
import { profitRoutes } from './routes/profit';
import { pricingRoutes } from './routes/pricing';
import { tefRoutes } from './routes/tef';
import { aiRoutes } from './routes/ai';
import { redactCosts } from './lib/redact';
import { leadPublicRoutes, supportAdminRoutes, supportRoutes } from './routes/support';
import { commercialBillingRoutes } from './routes/commercial-billing';
import { commercialReportsRoutes } from './routes/commercial-reports';
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
import { tableRequestRoutes } from './routes/table-requests';
import { notificationRoutes } from './routes/notifications';
import { commissionRoutes } from './routes/commissions';
import { networkRoutes } from './routes/network';
import { guideRoutes } from './routes/guide';
import { bankReconciliationRoutes } from './routes/bank-reconciliation';
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
import { fiscalRegistryRoutes } from './routes/fiscal-registry';
import { inboundRoutes, integrationRoutes } from './routes/integrations';
import { auditRoutes } from './routes/audit';
import { registerProviders } from './providers.config';

export const app = express();
app.set('trust proxy', 1);
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
// The Next apps proxy browser calls with their own Origin, so the configured app URLs are always allowed.
const appOrigins = [process.env.RM_RESTAURANT_URL, process.env.RM_ADMIN_URL].flatMap(value => { try { return value ? [new URL(value).origin] : []; } catch { return []; } });
const allowedOrigins = [...new Set([...parseAllowedOrigins(process.env.CORS_ORIGIN), ...appOrigins])];
// Development only: Codespaces/proxied hosts send arbitrary public Origins, so any origin is reflected outside production.
const allowAnyOrigin = () => process.env.NODE_ENV !== 'production';
app.use(cors({ origin: (origin, callback) => { if (!origin || allowAnyOrigin() || allowedOrigins.includes(origin)) return callback(null, true); return callback(new OriginNotAllowedError()); } }));
const productImagePath = /^\/store\/[^/]+\/(?:products\/[^/]+\/image|image\/(?:LOGO|COVER))$/;
const limiterMessage = { message: 'Too many requests. Try again later.' };
const printAgentPaths = '/print-agent';
const machinePaths = ['/print-agent', '/public', '/inbound', '/payments/webhook'];
// The print agent polls continuously from the restaurant network, so it has its own budget instead of the shared API one.
// The browser reaches the API through the Next proxy, so every user shares one IP: signed-in staff are limited per user (a screen makes several calls and
// the order monitor polls), while callers without a valid session keep the strict per-IP budget.
app.use('/api/v1', (req, res, next) => { res.locals.sessionKey = sessionRateKey(req); next(); });
app.use('/api/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 3000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage, keyGenerator: (_req, res) => res.locals.sessionKey, skip: (req, res) => !res.locals.sessionKey || machinePaths.some(prefix => req.path.startsWith(prefix)) }));
app.use('/api/v1', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage, skip: (req, res) => Boolean(res.locals.sessionKey) || machinePaths.some(prefix => req.path.startsWith(prefix)) }));
app.use(`/api/v1${printAgentPaths}`, rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/inbound', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/payments/webhook', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage }));
app.use('/api/v1/public', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage, skip: req => productImagePath.test(req.path) }));
app.use('/api/v1/public', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: limiterMessage, skip: req => !productImagePath.test(req.path) }));
// Webhook signatures are verified over the exact bytes received, so this path must bypass JSON parsing.
app.use('/api/v1/payments/webhook', express.raw({ type: () => true, limit: '256kb' }), paymentWebhookRoutes);
app.use(express.json({ limit: '1mb' }));
registerProviders();
app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'rm-restaurant-api', version: '1.0.0' }));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/migrations', migrationRoutes);
app.use('/api/v1/plans', planRoutes);
app.use('/api/v1/intelligence', intelligenceRoutes);
app.use('/api/v1/profit', profitRoutes);
app.use('/api/v1/pricing', pricingRoutes);
app.use('/api/v1/tef', tefRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/support', supportRoutes);
app.use('/api/v1/commercial', supportAdminRoutes);
app.use('/api/v1/commercial', commercialRoutes);
app.use('/api/v1/commercial', commercialBillingRoutes);
app.use('/api/v1/commercial/reports', commercialReportsRoutes);
// Profiles without financial permission never receive cost fields from operational routers.
for (const mount of ['products', 'inventory', 'orders', 'production', 'tables', 'delivery', 'catalog', 'dashboard']) app.use(`/api/v1/${mount}`, redactCosts);
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
app.use('/api/v1/reports', reportsExtraRoutes);
app.use('/api/v1/printing', printingRoutes);
app.use('/api/v1/print-agent', printAgentRoutes);
app.use('/api/v1/tables', tableRoutes);
app.use('/api/v1/table-requests', tableRequestRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/commissions', commissionRoutes);
app.use('/api/v1/network', networkRoutes);
app.use('/api/v1/guide', guideRoutes);
app.use('/api/v1/bank-reconciliation', bankReconciliationRoutes);
app.use('/api/v1/public/leads', leadPublicRoutes);
app.use('/api/v1/public/store', storeRoutes);
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
app.use('/api/v1/fiscal-registry', fiscalRegistryRoutes);
app.use('/api/v1/integrations', integrationRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/scale', scaleRoutes);
app.use('/api/v1/promotions', promotionRoutes);
app.use('/api/v1/category-schedules', categoryScheduleRoutes);
app.use('/api/v1/product-tools', productToolsRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/appearance', appearanceRoutes);
app.use('/api/v1/releases', releaseRoutes);
app.use('/api/v1/couriers', courierRoutes);
app.use('/api/v1/carriers', carrierRoutes);
app.use('/api/v1/payment-methods', paymentMethodRoutes);
app.use('/api/v1/financial-categories', financialCategoryRoutes);
app.use('/api/v1/cover-events', coverEventRoutes);
app.use('/api/v1/tax-rules', taxRuleRoutes);
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
  assertProductionEnv();
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => console.log(`RM Restaurant API listening on port ${port}`));
  ensureModuleCatalogOnce().then(created => { if (created) console.log(`module catalog: ${created} module(s) added automatically`); }).catch(error => console.error('module catalog sync failed:', error instanceof Error ? error.message : error));
  // In 'api' mode (default outside production) this process also owns the WhatsApp Web sessions and releases scheduled orders.
  if (whatsappSessionsMode() === 'api') {
    const manager = new WhatsappSessionManager(prisma);
    manager.start().catch(error => console.error('WhatsApp session manager not started:', error instanceof Error ? error.message : error));
    server.on('close', () => { void manager.stop(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void manager.stop().finally(() => process.exit(0)); });
  }
}
