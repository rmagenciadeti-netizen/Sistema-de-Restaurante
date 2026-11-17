import { Router, type Request } from 'express';
import { FiscalEnvironment, FiscalKind, FiscalStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { CASH_ROLES, FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { fiscalProviders } from '../lib/providers';
import { fiscalUnitKey, independentFiscalUnitIds, loadFiscalNumbering } from '../lib/fiscal-numbering';
import { certificateStatus, environmentOf, fiscalContext, fiscalContextForUnit, FiscalConfigError, inspectCertificate, issuerSchema, loadFiscalSettings, modelSchema, PDV_MODES, publicSettings, readinessProblems, sealSecret } from '../lib/fiscal-config';
import { buildFiscalOrder, consultDocument, emitForOrder, inutilize, recordEvent, retransmit, type Actor, type EmissionOptions } from '../lib/fiscal-service';
import { createZip } from '../lib/zip';

export const fiscalRoutes = Router();
fiscalRoutes.use(requireAuth, requireTenant);
const finance = requireRoles(...FINANCE_ROLES);
const manage = requireRoles(...MANAGEMENT_ROLES);
// Counter staff issue the NFC-e straight from the order board / PDV and may inutilize numbers from the PDV; everything else stays with finance.
const issuers = requireRoles(...CASH_ROLES);
const actorOf = (req: Request): Actor => ({ tenantId: req.auth!.tenantId!, userId: req.auth!.userId, unitId: req.auth!.unitId ?? null });
const unitScope = (req: Request) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});
const invalid = (error: z.ZodError) => ({ message: error.issues[0]?.message ?? 'Validation failed', errors: error.flatten() });
const audit = (req: Request, action: string, entityType: string, entityId: string, metadata?: Prisma.InputJsonValue) => prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action, entityType, entityId, metadata } });
const currentEnvironment = async (tenantId: string) => environmentOf(await loadFiscalSettings(prisma, tenantId));

// ---------------- Configuração fiscal (aba Fiscais) ----------------
fiscalRoutes.get('/settings', issuers, async (req, res, next) => {
  try { return res.json(publicSettings(await loadFiscalSettings(prisma, req.auth!.tenantId!), fiscalProviders.names())); } catch (error) { return next(error); }
});
const optionalSecret = z.string().trim().max(500).optional();
const settingsSchema = z.object({
  environment: z.nativeEnum(FiscalEnvironment).optional(), provider: z.string().trim().max(60).nullable().optional(), providerToken: optionalSecret,
  issuer: issuerSchema.optional(), nfe: modelSchema.optional(), nfce: modelSchema.optional(),
  cscId: z.string().trim().regex(/^\d{0,6}$/, 'ID do CSC deve ter até 6 dígitos').optional(), cscToken: optionalSecret,
  pdvMode: z.enum(PDV_MODES).optional(), defaultTaxRuleId: z.string().uuid().nullable().optional(),
});
fiscalRoutes.put('/settings', manage, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const tenantId = req.auth!.tenantId!; const { providerToken, cscToken, issuer, nfe, nfce, ...rest } = parsed.data;
    if (rest.provider && !fiscalProviders.get(rest.provider)) return res.status(400).json({ message: 'Provedor fiscal não disponível neste servidor.' });
    if (rest.defaultTaxRuleId && !await prisma.taxRule.findFirst({ where: { id: rest.defaultTaxRuleId, tenantId, active: true }, select: { id: true } })) return res.status(400).json({ message: 'Regra tributária padrão inválida ou inativa.' });
    const current = await loadFiscalSettings(prisma, tenantId);
    const data: Prisma.FiscalSettingsUncheckedUpdateInput = { ...rest, ...(issuer ? { issuer } : {}), ...(nfe ? { nfe } : {}), ...(nfce ? { nfce } : {}) };
    // Empty secret fields keep the stored value; tokens are only ever written encrypted.
    if (providerToken) data.providerTokenEnc = sealSecret(providerToken);
    if (cscToken) data.cscTokenEnc = sealSecret(cscToken);
    const next = { ...(current ?? {}), ...data } as Parameters<typeof readinessProblems>[0];
    if (rest.environment === FiscalEnvironment.PRODUCTION && current?.environment !== FiscalEnvironment.PRODUCTION) {
      const problems = [...new Set([...readinessProblems(next, 'NFCE', fiscalProviders.names()), ...readinessProblems(next, 'NFE', fiscalProviders.names())])].filter(problem => !problem.includes('CSC') || (next?.pdvMode ?? 'NON_FISCAL') !== 'NON_FISCAL');
      if (problems.length) return res.status(422).json({ message: `Complete a configuração antes de ativar produção: ${problems.join(' ')}`, problems });
    }
    const saved = await prisma.fiscalSettings.upsert({ where: { tenantId }, create: { ...(data as Prisma.FiscalSettingsUncheckedCreateInput), tenantId }, update: data });
    await audit(req, 'FISCAL_SETTINGS_UPDATED', 'FiscalSettings', saved.id, { environment: saved.environment, pdvMode: saved.pdvMode, fields: Object.keys(parsed.data) });
    return res.json(publicSettings(saved, fiscalProviders.names()));
  } catch (error) { return error instanceof FiscalConfigError ? res.status(error.status).json({ message: error.message }) : next(error); }
});
// Imports or replaces the A1 certificate: validated (password, holder, validity, CNPJ) and stored encrypted; never returned by the API.
fiscalRoutes.post('/settings/certificate', manage, async (req, res, next) => {
  try {
    const parsed = z.object({ pfxBase64: z.string().min(100).max(60_000), password: z.string().min(1).max(200) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Envie o arquivo .pfx/.p12 e a senha.' });
    const tenantId = req.auth!.tenantId!; const pfx = Buffer.from(parsed.data.pfxBase64, 'base64');
    const current = await loadFiscalSettings(prisma, tenantId);
    const issuerCnpj = (current?.issuer as { cnpj?: string } | null)?.cnpj ?? null;
    const info = inspectCertificate(pfx, parsed.data.password, issuerCnpj);
    if (info.validTo < new Date()) return res.status(422).json({ message: `Certificado vencido em ${info.validTo.toLocaleDateString('pt-BR')}.` });
    const data = { certPfxEnc: sealSecret(pfx), certPasswordEnc: sealSecret(parsed.data.password), certSubject: info.subject, certCnpj: info.cnpj, certValidFrom: info.validFrom, certValidTo: info.validTo, certUploadedAt: new Date() };
    const saved = await prisma.fiscalSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    await recordEvent({ tenantId, environment: saved.environment, type: 'CERTIFICATE', status: current?.certPfxEnc ? 'REPLACED' : 'IMPORTED', message: `${info.subject} — válido até ${info.validTo.toISOString().slice(0, 10)}`, actorUserId: req.auth!.userId });
    await audit(req, 'FISCAL_CERTIFICATE_IMPORTED', 'FiscalSettings', saved.id, { cnpj: info.cnpj, validTo: info.validTo.toISOString() });
    return res.status(201).json({ ...publicSettings(saved, fiscalProviders.names()), certificateWarnings: info.warnings });
  } catch (error) { return error instanceof FiscalConfigError ? res.status(error.status).json({ message: error.message }) : next(error); }
});
fiscalRoutes.post('/settings/certificate/test', manage, async (req, res, next) => {
  try {
    const settings = await loadFiscalSettings(prisma, req.auth!.tenantId!);
    const context = fiscalContext(settings);
    if (!context.certificate) return res.status(404).json({ message: 'Nenhum certificado cadastrado.' });
    const issuerCnpj = (settings?.issuer as { cnpj?: string } | null)?.cnpj ?? null;
    const info = inspectCertificate(Buffer.from(context.certificate.pfxBase64, 'base64'), context.certificate.password, issuerCnpj);
    const expired = info.validTo < new Date();
    return res.json({ ok: !expired, message: expired ? 'Certificado vencido.' : `Certificado válido até ${info.validTo.toLocaleDateString('pt-BR')}.`, subject: info.subject, cnpj: info.cnpj, validTo: info.validTo, warnings: info.warnings });
  } catch (error) { return error instanceof FiscalConfigError ? res.status(error.status).json({ message: error.message }) : next(error); }
});

const fiscalUnitParams = z.object({ unitId: z.string().uuid() });
// Users bound to one establishment only manage that establishment's fiscal data; company-level users manage all of them.
const getFiscalUnit = async (req: Request, unitId: string) => {
  if (req.auth!.unitId && req.auth!.unitId !== unitId) return null;
  return prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! }, select: { id: true } });
};
fiscalRoutes.get('/settings/units/:unitId', issuers, async (req, res, next) => {
  try {
    const params = fiscalUnitParams.safeParse(req.params);
    if (!params.success) return res.status(400).json(invalid(params.error));
    const tenantId = req.auth!.tenantId!; const { unitId } = params.data;
    if (!await getFiscalUnit(req, unitId)) return res.status(404).json({ message: 'Unidade não encontrada.' });
    const [company, config] = await Promise.all([
      loadFiscalSettings(prisma, tenantId),
      prisma.fiscalUnitConfig.findFirst({ where: { tenantId, unitId } }),
    ]);
    const unitIssuer = issuerSchema.parse(config?.issuer ?? {});
    const issuer = unitIssuer.cnpj || unitIssuer.legalName ? unitIssuer : issuerSchema.parse(company?.issuer ?? {});
    const certificate = config?.certPfxEnc ? config : company;
    return res.json({
      configured: Boolean(config), issuer, ownCertificate: Boolean(config?.certPfxEnc),
      certificate: certificate?.certPfxEnc
        ? { subject: certificate.certSubject, cnpj: certificate.certCnpj, validFrom: certificate.certValidFrom, validTo: certificate.certValidTo, uploadedAt: certificate.certUploadedAt, ...certificateStatus(certificate) }
        : certificateStatus(certificate),
    });
  } catch (error) { return next(error); }
});
fiscalRoutes.put('/settings/units/:unitId', manage, async (req, res, next) => {
  try {
    const params = fiscalUnitParams.safeParse(req.params); const parsed = z.object({ issuer: issuerSchema }).safeParse(req.body);
    if (!params.success) return res.status(400).json(invalid(params.error));
    if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const tenantId = req.auth!.tenantId!; const { unitId } = params.data;
    if (!await getFiscalUnit(req, unitId)) return res.status(404).json({ message: 'Unidade não encontrada.' });
    const current = await prisma.fiscalUnitConfig.findFirst({ where: { tenantId, unitId }, select: { certCnpj: true } });
    if (current?.certCnpj && parsed.data.issuer.cnpj && current.certCnpj.slice(0, 8) !== parsed.data.issuer.cnpj.slice(0, 8)) return res.status(422).json({ message: 'O certificado cadastrado pertence a outra empresa. Substitua-o antes de alterar o CNPJ desta unidade.' });
    const saved = await prisma.fiscalUnitConfig.upsert({ where: { unitId }, create: { tenantId, unitId, issuer: parsed.data.issuer }, update: { issuer: parsed.data.issuer } });
    await audit(req, 'FISCAL_UNIT_SETTINGS_UPDATED', 'FiscalUnitConfig', saved.id, { unitId, cnpj: parsed.data.issuer.cnpj });
    return res.json({ configured: true, issuer: issuerSchema.parse(saved.issuer), ownCertificate: Boolean(saved.certPfxEnc), certificate: saved.certPfxEnc ? { subject: saved.certSubject, cnpj: saved.certCnpj, validFrom: saved.certValidFrom, validTo: saved.certValidTo, uploadedAt: saved.certUploadedAt, ...certificateStatus(saved) } : certificateStatus(saved) });
  } catch (error) { return next(error); }
});
fiscalRoutes.post('/settings/units/:unitId/certificate', manage, async (req, res, next) => {
  try {
    const params = fiscalUnitParams.safeParse(req.params);
    const parsed = z.object({ pfxBase64: z.string().min(100).max(60_000), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!params.success) return res.status(400).json(invalid(params.error));
    if (!parsed.success) return res.status(400).json({ message: 'Envie o arquivo .pfx/.p12 e a senha.' });
    const tenantId = req.auth!.tenantId!; const { unitId } = params.data;
    if (!await getFiscalUnit(req, unitId)) return res.status(404).json({ message: 'Unidade não encontrada.' });
    const current = await prisma.fiscalUnitConfig.findFirst({ where: { tenantId, unitId } });
    const issuer = issuerSchema.parse(current?.issuer ?? (await loadFiscalSettings(prisma, tenantId))?.issuer ?? {});
    const pfx = Buffer.from(parsed.data.pfxBase64, 'base64');
    const info = inspectCertificate(pfx, parsed.data.password, issuer.cnpj || null);
    if (info.validTo < new Date()) return res.status(422).json({ message: `Certificado vencido em ${info.validTo.toLocaleDateString('pt-BR')}.` });
    const data = { certPfxEnc: sealSecret(pfx), certPasswordEnc: sealSecret(parsed.data.password), certSubject: info.subject, certCnpj: info.cnpj, certIssuer: info.issuer, certSerial: info.serial, certValidFrom: info.validFrom, certValidTo: info.validTo, certUploadedAt: new Date() };
    const saved = await prisma.fiscalUnitConfig.upsert({ where: { unitId }, create: { tenantId, unitId, issuer, ...data }, update: data });
    await recordEvent({ tenantId, unitId, environment: await currentEnvironment(tenantId), type: 'CERTIFICATE', status: current?.certPfxEnc ? 'REPLACED' : 'IMPORTED', message: `${info.subject} — válido até ${info.validTo.toISOString().slice(0, 10)}`, actorUserId: req.auth!.userId });
    await audit(req, 'FISCAL_UNIT_CERTIFICATE_IMPORTED', 'FiscalUnitConfig', saved.id, { unitId, cnpj: info.cnpj, validTo: info.validTo.toISOString() });
    return res.status(201).json({ configured: true, issuer: issuerSchema.parse(saved.issuer), ownCertificate: true, certificate: { subject: saved.certSubject, cnpj: saved.certCnpj, validFrom: saved.certValidFrom, validTo: saved.certValidTo, uploadedAt: saved.certUploadedAt, ...certificateStatus(saved) }, certificateWarnings: info.warnings });
  } catch (error) { return error instanceof FiscalConfigError ? res.status(error.status).json({ message: error.message }) : next(error); }
});
fiscalRoutes.post('/settings/test-connection', manage, async (req, res, next) => {
  try {
    const settings = await loadFiscalSettings(prisma, req.auth!.tenantId!);
    const provider = settings?.provider ? fiscalProviders.get(settings.provider) : undefined;
    if (!provider) return res.status(501).json({ message: 'Selecione um provedor fiscal.' });
    if (!provider.testConnection) return res.status(501).json({ message: 'O provedor não oferece teste de comunicação.' });
    const result = await provider.testConnection(fiscalContext(settings)).catch(error => ({ ok: false, message: error instanceof Error && error.name !== 'Error' ? error.message : 'Falha de comunicação com o provedor fiscal.' }));
    await recordEvent({ tenantId: req.auth!.tenantId!, environment: environmentOf(settings), type: 'CONNECTION_TEST', status: result.ok ? 'OK' : 'FAILED', message: result.message, actorUserId: req.auth!.userId });
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (error) { return error instanceof FiscalConfigError ? res.status(error.status).json({ message: error.message }) : next(error); }
});

// ---------------- Numeração ----------------
fiscalRoutes.get('/providers', issuers, (_req, res) => res.json({ items: fiscalProviders.names() }));
fiscalRoutes.get('/numbering', finance, async (req, res, next) => {
  try { const tenantId = req.auth!.tenantId!; const environment = await currentEnvironment(tenantId); const unitKey = await fiscalUnitKey(prisma, tenantId, req.auth!.unitId ?? null); const items = await loadFiscalNumbering(prisma, tenantId, environment, unitKey); return res.json({ items, total: items.length, environment }); }
  catch (error) { return next(error); }
});
// Sets the series and the next number of the current environment. A series can only move forward so a number is never issued twice.
fiscalRoutes.put('/numbering', manage, async (req, res, next) => {
  try {
    const parsed = z.object({ kind: z.nativeEnum(FiscalKind).default(FiscalKind.NFCE), series: z.string().trim().regex(/^\d{1,3}$/, 'A série deve ter de 1 a 3 dígitos'), nextNumber: z.number().int().min(1).max(999_999_999) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const { kind, series, nextNumber } = parsed.data; const unitKey = await fiscalUnitKey(prisma, tenantId, req.auth!.unitId ?? null);
    const environment = await currentEnvironment(tenantId);
    const saved = await prisma.$transaction(async tx => {
      await tx.fiscalNumbering.createMany({ data: [{ tenantId, kind, environment, unitKey }], skipDuplicates: true });
      const current = await tx.fiscalNumbering.findUniqueOrThrow({ where: { tenantId_unitKey_kind_environment: { tenantId, unitKey, kind, environment } } });
      // Company numbering ignores establishments that issue with their own CNPJ (they own a separate number space).
      const independents = unitKey ? [] : await independentFiscalUnitIds(tx, tenantId);
      const unitFilter = unitKey ? Prisma.sql`AND "unitId" = ${unitKey}` : independents.length ? Prisma.sql`AND ("unitId" IS NULL OR "unitId" NOT IN (${Prisma.join(independents)}))` : Prisma.empty;
      const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`SELECT max("number"::int) AS max FROM "FiscalDocument" WHERE "tenantId" = ${tenantId} AND "kind" = ${kind}::"FiscalKind" AND "environment" = ${environment}::"FiscalEnvironment" AND "series" = ${series} ${unitFilter} AND "number" ~ '^[0-9]{1,9}$'`;
      const eventScope = unitKey ? { unitId: unitKey } : independents.length ? { OR: [{ unitId: null }, { unitId: { notIn: independents } }] } : {};
      const inutilized = await tx.fiscalEvent.aggregate({ where: { tenantId, ...eventScope, kind, environment, series, type: 'INUTILIZATION', status: 'REGISTERED' }, _max: { numberTo: true } });
      const highest = Math.max(max ?? 0, inutilized._max.numberTo ?? 0, series === current.series ? current.nextNumber - 1 : 0);
      if (nextNumber <= highest) return { conflict: highest } as const;
      const row = await tx.fiscalNumbering.update({ where: { id: current.id }, data: { series, nextNumber } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'FISCAL_NUMBERING_UPDATED', entityType: 'FiscalNumbering', entityId: row.id, metadata: { kind, series, nextNumber, environment } } });
      return { row } as const;
    });
    if ('conflict' in saved) return res.status(409).json({ message: `A série ${series} já emitiu até o número ${saved.conflict}. Informe um número maior.` });
    return res.json({ kind, series: saved.row.series, nextNumber: saved.row.nextNumber, environment });
  } catch (error) { return next(error); }
});

// ---------------- Documentos ----------------
const listSchema = z.object({
  status: z.string().optional().transform(value => (value ? value.split(',').filter(item => (Object.values(FiscalStatus) as string[]).includes(item)) as FiscalStatus[] : undefined)),
  kind: z.nativeEnum(FiscalKind).optional(), environment: z.nativeEnum(FiscalEnvironment).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  q: z.string().trim().max(60).optional(), contingency: z.enum(['true', 'false']).optional(), take: z.coerce.number().int().min(1).max(500).default(100),
});
function documentWhere(req: Request, query: z.infer<typeof listSchema>): Prisma.FiscalDocumentWhereInput {
  const digits = query.q?.replace(/\D/g, '');
  return {
    tenantId: req.auth!.tenantId!, ...unitScope(req), ...(query.status?.length ? { status: { in: query.status } } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.environment ? { environment: query.environment } : {}),
    ...(query.contingency ? { contingency: query.contingency === 'true' } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    ...(query.q ? { OR: [{ number: query.q }, ...(digits && digits.length >= 4 ? [{ accessKey: { contains: digits } }] : []), { order: { code: { contains: query.q, mode: 'insensitive' as const } } }, { order: { customerName: { contains: query.q, mode: 'insensitive' as const } } }, { order: { customer: { document: { contains: digits || query.q } } } }] } : {}),
  };
}
const listSelect = { id: true, tenantId: true, unitId: true, orderId: true, provider: true, kind: true, status: true, series: true, number: true, accessKey: true, documentUrl: true, error: true, environment: true, protocol: true, statusCode: true, contingency: true, contingencyAt: true, attempts: true, lastAttemptAt: true, createdAt: true, updatedAt: true, order: { select: { code: true, total: true, customerName: true, customer: { select: { name: true, document: true } } } } } satisfies Prisma.FiscalDocumentSelect;
fiscalRoutes.get('/documents', finance, async (req, res, next) => {
  try {
    const query = listSchema.safeParse(req.query); if (!query.success) return res.status(400).json(invalid(query.error));
    const items = await prisma.fiscalDocument.findMany({ where: documentWhere(req, query.data), select: { ...listSelect, xml: false }, orderBy: { createdAt: 'desc' }, take: query.data.take });
    const withXml = new Set((await prisma.fiscalDocument.findMany({ where: { id: { in: items.map(item => item.id) }, xml: { not: null } }, select: { id: true } })).map(item => item.id));
    return res.json({ items: items.map(item => ({ ...item, hasXml: withXml.has(item.id) })), total: items.length });
  } catch (error) { return next(error); }
});
fiscalRoutes.get('/documents/:id', finance, async (req, res, next) => {
  try {
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req) }, select: { ...listSelect, payload: true, events: { select: { id: true, type: true, status: true, protocol: true, message: true, sequence: true, actorUserId: true, createdAt: true, xml: false }, orderBy: { createdAt: 'desc' } } } });
    if (!document) return res.status(404).json({ message: 'Documento não encontrado.' });
    return res.json(document);
  } catch (error) { return next(error); }
});
// Counter staff print the DANFE of documents they are allowed to emit; the XML read keeps the unit scope.
fiscalRoutes.get('/documents/:id/xml', issuers, async (req, res, next) => {
  try {
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req) }, select: { xml: true, accessKey: true, number: true, kind: true } });
    if (!document?.xml) return res.status(404).json({ message: 'XML não disponível para este documento.' });
    return res.json({ fileName: `${document.accessKey ?? `${document.kind}-${document.number}`}-${document.kind === 'NFE' ? 'nfe' : 'nfce'}.xml`, xml: document.xml });
  } catch (error) { return next(error); }
});
fiscalRoutes.get('/events/:id/xml', finance, async (req, res, next) => {
  try {
    const event = await prisma.fiscalEvent.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, select: { xml: true, type: true, createdAt: true, id: true } });
    if (!event?.xml) return res.status(404).json({ message: 'XML não disponível para este evento.' });
    return res.json({ fileName: `${event.type.toLowerCase()}-${event.id.slice(0, 8)}.xml`, xml: event.xml });
  } catch (error) { return next(error); }
});

const emitSchema = z.object({
  provider: z.string().min(1).max(60).optional(), kind: z.nativeEnum(FiscalKind).default(FiscalKind.NFCE),
  nature: z.string().trim().min(2).max(60).optional(), finality: z.enum(['1', '2', '3', '4']).optional(),
  freight: z.number().min(0).max(1_000_000).optional(), otherExpenses: z.number().min(0).max(1_000_000).optional(), additionalInfo: z.string().trim().max(2000).optional(),
  recipient: z.object({
    name: z.string().trim().max(120).nullable(), document: z.string().trim().max(20).nullable().transform(value => value?.replace(/\D/g, '') || null).refine(value => !value || value.length === 11 || value.length === 14, 'CPF/CNPJ inválido'),
    email: z.string().trim().email().max(120).nullable().optional(), stateRegistration: z.string().trim().max(20).nullable().optional(), contributorIndicator: z.enum(['1', '2', '9']).optional(),
    address: z.object({ street: z.string().trim().min(1).max(120), number: z.string().trim().min(1).max(20), complement: z.string().trim().max(60).optional(), district: z.string().trim().min(1).max(60), city: z.string().trim().min(1).max(60), cityIbge: z.string().regex(/^\d{7}$/, 'Código IBGE com 7 dígitos'), uf: z.string().regex(/^[A-Z]{2}$/), cep: z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos') }).nullable().optional(),
  }).nullable().optional(),
  items: z.array(z.object({ index: z.number().int().min(0) }).catchall(z.union([z.string().max(20), z.number(), z.null()]))).max(500).optional(),
});
fiscalRoutes.post('/orders/:orderId/emit', issuers, async (req, res, next) => {
  try {
    const parsed = emitSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const result = await emitForOrder(actorOf(req), req.params.orderId, parsed.data as EmissionOptions);
    return res.status(result.status).json(result.body);
  } catch (error) { return next(error); }
});
// DANFE preview data (sem valor fiscal): same payload the provider would receive, with the number the document would take.
fiscalRoutes.post('/orders/:orderId/preview', issuers, async (req, res, next) => {
  try {
    const parsed = emitSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const settings = await prisma.fiscalSettings.findUnique({ where: { tenantId }, include: { defaultTaxRule: true } });
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId, ...unitScope(req) }, include: { items: { where: { parentItemId: null }, include: { product: { select: { name: true, code: true, gtin: true, measureUnit: true, ncm: true, cest: true, taxRule: true } } } }, customer: { select: { name: true, document: true, email: true } }, payments: { where: { status: 'CONFIRMED' }, select: { method: true, amount: true } }, fiscalDocuments: { where: { kind: parsed.data.kind }, select: { series: true, number: true } } } });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const environment = environmentOf(settings);
    const unitKey = await fiscalUnitKey(prisma, tenantId, order.unitId);
    const numbering = order.fiscalDocuments[0]?.number ? { series: order.fiscalDocuments[0].series ?? '1', number: order.fiscalDocuments[0].number } : (await loadFiscalNumbering(prisma, tenantId, environment, unitKey)).filter(item => item.kind === parsed.data.kind).map(item => ({ series: item.series, number: String(item.nextNumber) }))[0];
    const built = buildFiscalOrder(order, settings, parsed.data as EmissionOptions, numbering);
    if ('untaxed' in built) return res.status(422).json({ message: `Vincule uma regra tributária ativa (Fiscal / Tributos) aos produtos: ${built.untaxed.join(', ')}.` });
    const unitConfig = order.unitId ? await prisma.fiscalUnitConfig.findFirst({ where: { tenantId, unitId: order.unitId }, select: { issuer: true } }) : null;
    const configuredUnitIssuer = issuerSchema.parse(unitConfig?.issuer ?? {});
    const companyIssuer = publicSettings(settings, []).issuer;
    const issuer = configuredUnitIssuer.cnpj || configuredUnitIssuer.legalName ? configuredUnitIssuer : companyIssuer;
    return res.json({ preview: true, environment, kind: parsed.data.kind, issuer, document: built.fiscalOrder, subtotal: order.subtotal, discount: order.discount, total: order.total });
  } catch (error) { return next(error); }
});

// PDV: applies the company's fiscal behaviour once per sale (FISCAL / NON_FISCAL / ASK) and records who decided and when.
fiscalRoutes.post('/orders/:orderId/checkout', issuers, async (req, res, next) => {
  try {
    const parsed = z.object({ emit: z.boolean().optional() }).safeParse(req.body ?? {}); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const settings = await loadFiscalSettings(prisma, tenantId);
    const mode = (settings?.pdvMode ?? 'NON_FISCAL') as typeof PDV_MODES[number];
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId, ...unitScope(req) }, select: { id: true, fiscalMode: true } });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.fiscalMode) return res.status(409).json({ message: 'A decisão fiscal desta venda já foi registrada.', fiscalMode: order.fiscalMode });
    if (mode === 'ASK' && parsed.data.emit === undefined) return res.status(400).json({ message: 'Informe se deseja emitir documento fiscal para esta venda.' });
    // The operator's answer can never skip a mandatory emission.
    if (mode === 'FISCAL' && parsed.data.emit === false) return res.status(409).json({ message: 'A configuração da empresa exige documento fiscal em todas as vendas.' });
    const emit = mode === 'FISCAL' || (mode === 'ASK' && parsed.data.emit === true);
    const decided = await prisma.order.updateMany({ where: { id: order.id, fiscalMode: null }, data: { fiscalMode: emit ? 'FISCAL' : 'NON_FISCAL', fiscalDecidedById: req.auth!.userId, fiscalDecidedAt: new Date() } });
    if (decided.count !== 1) return res.status(409).json({ message: 'A decisão fiscal desta venda já foi registrada.' });
    await audit(req, 'PDV_FISCAL_DECISION', 'Order', order.id, { mode, emit });
    if (!emit) return res.json({ fiscalMode: 'NON_FISCAL', document: null });
    // The sale is already registered: emission problems are reported, never turned into a failed checkout.
    const result = await emitForOrder(actorOf(req), order.id, { kind: FiscalKind.NFCE });
    const body = result.body as { id?: string; message?: string };
    return res.json({ fiscalMode: 'FISCAL', document: body.id ? body : null, emission: { httpStatus: result.status, message: body.message ?? null } });
  } catch (error) { return next(error); }
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(50).optional(), all: z.boolean().optional() });
const pendingStatuses = [FiscalStatus.PROCESSING, FiscalStatus.CONTINGENCY, FiscalStatus.PENDING, FiscalStatus.REJECTED];
async function pickDocuments(req: Request, ids: string[] | undefined, statuses: FiscalStatus[]) {
  const environment = await currentEnvironment(req.auth!.tenantId!);
  return prisma.fiscalDocument.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req), environment, status: { in: statuses }, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { createdAt: 'asc' }, take: 50 });
}
fiscalRoutes.post('/documents/:id/consult', finance, async (req, res, next) => {
  try {
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req) } });
    if (!document) return res.status(404).json({ message: 'Documento não encontrado.' });
    const result = await consultDocument(actorOf(req), document);
    return 'failure' in result ? res.status(422).json({ message: result.failure }) : res.json(result);
  } catch (error) { return next(error); }
});
// Batch consultation (selected or every pending document of the current environment), sequential to respect the provider's limits.
fiscalRoutes.post('/documents/consult', finance, async (req, res, next) => {
  try {
    const parsed = idsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const documents = await pickDocuments(req, parsed.data.ids, [...pendingStatuses, FiscalStatus.AUTHORIZED]);
    const results = [];
    for (const document of documents) { const result = await consultDocument(actorOf(req), document); results.push({ id: document.id, ...('failure' in result ? { error: result.failure } : { status: result.status }) }); }
    return res.json({ processed: results.length, results });
  } catch (error) { return next(error); }
});
fiscalRoutes.post('/documents/transmit', finance, async (req, res, next) => {
  try {
    const parsed = idsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const documents = await pickDocuments(req, parsed.data.ids, pendingStatuses);
    const results = [];
    for (const document of documents) { const result = await retransmit(actorOf(req), document); results.push({ id: document.id, ...('failure' in result ? { error: result.failure } : { status: result.status, message: result.error }) }); }
    return res.json({ processed: results.length, results });
  } catch (error) { return next(error); }
});
fiscalRoutes.post('/documents/:id/cancel', finance, async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().min(15).max(255) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'A cancellation reason of at least 15 characters is required' });
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req), status: FiscalStatus.AUTHORIZED } });
    if (!document) return res.status(404).json({ message: 'Authorized document not found' });
    const provider = fiscalProviders.get(document.provider);
    if (!provider) return res.status(501).json({ message: 'Fiscal provider is not configured' });
    const settings = await loadFiscalSettings(prisma, document.tenantId);
    const context = settings ? await fiscalContextForUnit(prisma, settings, req.auth!.tenantId!, document.unitId) : undefined;
    const result = await provider.cancel({ number: document.number, accessKey: document.accessKey, ref: document.id, kind: document.kind }, parsed.data.reason, context).catch(error => ({ cancelled: false, error: error instanceof FiscalConfigError ? error.message : 'PROVIDER_ERROR', protocol: undefined, xml: undefined }));
    await recordEvent({ tenantId: document.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: 'CANCEL', status: result.cancelled ? 'REGISTERED' : 'REJECTED', kind: document.kind, justification: parsed.data.reason, protocol: result.protocol, message: result.error ?? null, xml: result.xml, actorUserId: req.auth!.userId });
    if (!result.cancelled) return res.status(422).json({ message: result.error ?? 'Provider refused the cancellation' });
    const saved = await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: FiscalStatus.CANCELLED } });
    await audit(req, 'FISCAL_CANCELLED', 'FiscalDocument', document.id);
    return res.json(saved);
  } catch (error) { return next(error); }
});
// Carta de Correção Eletrônica (NF-e only): up to 20 sequential corrections per document.
fiscalRoutes.post('/documents/:id/correction', finance, async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().trim().min(15, 'A correção deve ter no mínimo 15 caracteres').max(1000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req), status: FiscalStatus.AUTHORIZED, kind: FiscalKind.NFE } });
    if (!document) return res.status(404).json({ message: 'NF-e autorizada não encontrada (CC-e não se aplica à NFC-e).' });
    const provider = fiscalProviders.get(document.provider);
    if (!provider?.correct) return res.status(501).json({ message: 'O provedor fiscal não oferece Carta de Correção.' });
    const sequence = await prisma.fiscalEvent.count({ where: { documentId: document.id, type: 'CORRECTION', status: 'REGISTERED' } }) + 1;
    if (sequence > 20) return res.status(409).json({ message: 'Limite de 20 cartas de correção atingido.' });
    const settings = await loadFiscalSettings(prisma, document.tenantId);
    const context = await fiscalContextForUnit(prisma, settings, req.auth!.tenantId!, document.unitId);
    const result = await provider.correct({ ref: document.id, kind: document.kind, number: document.number, series: document.series, accessKey: document.accessKey }, parsed.data.text, sequence, context).catch(error => ({ status: 'REJECTED' as const, error: error instanceof FiscalConfigError ? error.message : 'Falha de comunicação com o provedor fiscal.', protocol: undefined, xml: undefined }));
    const event = await recordEvent({ tenantId: document.tenantId, unitId: document.unitId, documentId: document.id, environment: document.environment, type: 'CORRECTION', status: result.status, kind: document.kind, sequence, justification: parsed.data.text, protocol: result.protocol, message: result.error ?? null, xml: result.xml, actorUserId: req.auth!.userId });
    return res.status(result.status === 'REGISTERED' ? 201 : 422).json({ ...event, xml: undefined, message: result.error });
  } catch (error) { return next(error); }
});

// ---------------- Inutilização (área fiscal e PDV) ----------------
fiscalRoutes.get('/inutilizations', issuers, async (req, res, next) => {
  try {
    const items = await prisma.fiscalEvent.findMany({ where: { tenantId: req.auth!.tenantId!, type: 'INUTILIZATION' }, select: { id: true, environment: true, status: true, kind: true, series: true, numberFrom: true, numberTo: true, justification: true, protocol: true, message: true, actorUserId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
fiscalRoutes.post('/inutilizations', issuers, async (req, res, next) => {
  try {
    const parsed = z.object({ kind: z.nativeEnum(FiscalKind), series: z.string().trim().regex(/^\d{1,3}$/, 'Série inválida'), numberFrom: z.number().int().min(1).max(999_999_999), numberTo: z.number().int().min(1).max(999_999_999), justification: z.string().trim().min(15, 'A justificativa deve ter de 15 a 255 caracteres').max(255) })
      .refine(value => value.numberTo >= value.numberFrom, 'O número final deve ser maior ou igual ao inicial').refine(value => value.numberTo - value.numberFrom < 10_000, 'Inutilize no máximo 10.000 números por pedido').safeParse(req.body);
    if (!parsed.success) return res.status(400).json(invalid(parsed.error));
    const result = await inutilize(actorOf(req), parsed.data);
    return res.status(result.status).json(result.body);
  } catch (error) { return next(error); }
});

// ---------------- XML: exportação (ZIP) ----------------
const exportSchema = listSchema.extend({ ids: z.string().optional().transform(value => (value ? value.split(',').filter(id => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 1000) : undefined)), events: z.enum(['true', 'false']).default('true') });
fiscalRoutes.get('/xml/export', finance, async (req, res, next) => {
  try {
    const query = exportSchema.safeParse(req.query); if (!query.success) return res.status(400).json(invalid(query.error));
    const environment = query.data.environment ?? await currentEnvironment(req.auth!.tenantId!);
    const where = { ...documentWhere(req, { ...query.data, environment }), ...(query.data.ids ? { id: { in: query.data.ids } } : {}), xml: { not: null } };
    const documents = await prisma.fiscalDocument.findMany({ where, select: { id: true, kind: true, number: true, series: true, accessKey: true, xml: true, createdAt: true, status: true }, orderBy: { createdAt: 'asc' }, take: 5000 });
    const range = query.data.from || query.data.to ? { createdAt: { ...(query.data.from ? { gte: query.data.from } : {}), ...(query.data.to ? { lte: query.data.to } : {}) } } : {};
    const events = query.data.events === 'true' ? await prisma.fiscalEvent.findMany({ where: { tenantId: req.auth!.tenantId!, environment, xml: { not: null }, ...(query.data.kind ? { kind: query.data.kind } : {}), ...(query.data.ids ? { documentId: { in: query.data.ids } } : range), type: { in: ['CANCEL', 'CORRECTION', 'INUTILIZATION'] } }, select: { id: true, type: true, kind: true, series: true, numberFrom: true, numberTo: true, sequence: true, xml: true, createdAt: true, document: { select: { accessKey: true, number: true } } }, take: 5000 }) : [];
    if (documents.length + events.length === 0) return res.status(404).json({ message: 'Nenhum XML encontrado com os filtros informados.' });
    const env = environment === 'PRODUCTION' ? 'producao' : 'homologacao';
    const month = (date: Date) => date.toISOString().slice(0, 7);
    const model = (kind: FiscalKind | null) => (kind === 'NFE' ? 'NFe-55' : 'NFCe-65');
    const zip = createZip([
      ...documents.map(doc => ({ name: `${env}/${model(doc.kind)}/${month(doc.createdAt)}/${doc.accessKey ?? `serie${doc.series}-n${doc.number}`}-${doc.kind === 'NFE' ? 'nfe' : 'nfce'}.xml`, data: doc.xml!, date: doc.createdAt })),
      ...events.map(event => ({ name: `${env}/${model(event.kind)}/${month(event.createdAt)}/eventos/${event.type === 'CANCEL' ? 'cancelamento' : event.type === 'CORRECTION' ? `cce-${event.sequence}` : 'inutilizacao'}-${event.document?.accessKey ?? `serie${event.series}-${event.numberFrom}-${event.numberTo}`}.xml`, data: event.xml!, date: event.createdAt })),
    ]);
    await audit(req, 'FISCAL_XML_EXPORTED', 'FiscalDocument', documents[0]?.id ?? events[0]!.id, { documents: documents.length, events: events.length, environment });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="xml-${env}-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.setHeader('X-Document-Count', String(documents.length)); res.setHeader('X-Event-Count', String(events.length));
    res.setHeader('Access-Control-Expose-Headers', 'X-Document-Count, X-Event-Count, Content-Disposition');
    return res.send(zip);
  } catch (error) { return next(error); }
});
