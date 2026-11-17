import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { requireRoles, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { loadSettings } from '../lib/settings';
import { SCALE_BRANDS, buildScaleFile, parseScaleBarcode } from '../lib/scale';

export const scaleRoutes = Router();
scaleRoutes.use(requireAuth, requireTenant);

const unitScope = (unitId: string | null) => (unitId ? { OR: [{ unitId }, { unitId: null }] } : {});
const scaleSelect = { id: true, name: true, price: true, scaleCode: true, soldByWeight: true, scaleDepartment: true, shelfLifeDays: true, scaleNotes: true, active: true } as const;

scaleRoutes.get('/lookup', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode : '';
    const { tenantId, unitId } = req.auth!;
    const config = (await loadSettings(prisma, tenantId!)).scale;
    if (!config.enabled) return res.status(404).json({ message: 'A leitura de etiquetas de balança está desativada nas configurações.' });
    const parsed = parseScaleBarcode(barcode, config);
    if (!parsed) return res.status(404).json({ message: 'Código de barras de balança inválido.' });
    const product = await prisma.product.findFirst({ where: { tenantId: tenantId!, scaleCode: parsed.scaleCode, active: true, ...unitScope(unitId) }, select: scaleSelect });
    if (!product) return res.status(404).json({ message: 'Nenhum produto ativo com esse código de balança.' });
    return res.json({
      product: { id: product.id, name: product.name, price: product.price.toFixed(2), scaleCode: product.scaleCode, soldByWeight: product.soldByWeight },
      kind: parsed.kind,
      ...(parsed.kind === 'WEIGHT' ? { weightKg: parsed.weightKg!.toFixed(3) } : { total: parsed.total!.toFixed(2) }),
    });
  } catch (error) { return next(error); }
});

async function scaleProducts(tenantId: string, unitId: string | null) {
  return prisma.product.findMany({ where: { tenantId, active: true, sendToScale: true, scaleCode: { not: null }, ...unitScope(unitId) }, select: scaleSelect, orderBy: { scaleCode: 'asc' } });
}

scaleRoutes.get('/products', requireRoles(...ALL_TENANT_ROLES), async (req, res, next) => {
  try {
    const items = await scaleProducts(req.auth!.tenantId!, req.auth!.unitId);
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

scaleRoutes.get('/export', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  const brand = z.enum(SCALE_BRANDS).safeParse(req.query.brand);
  if (!brand.success) return res.status(400).json({ message: 'Informe a marca da balança: TOLEDO, FILIZOLA, URANO ou URANO_URF32.' });
  try {
    const { tenantId, unitId, userId } = req.auth!;
    const products = await scaleProducts(tenantId!, unitId);
    const file = buildScaleFile(brand.data, products.map(product => ({
      scaleCode: product.scaleCode!, name: product.name, price: product.price, sellByWeight: product.soldByWeight,
      shelfLifeDays: product.shelfLifeDays, department: product.scaleDepartment, notes: product.scaleNotes,
    })));
    await prisma.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'SCALE_FILE_EXPORTED', entityType: 'Product', metadata: { brand: brand.data, products: products.length } } });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(file.content);
  } catch (error) { return next(error); }
});
