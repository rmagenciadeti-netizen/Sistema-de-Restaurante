import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { setAiProvider } from '../lib/ai-provider';
import { callModel, resetBreaker } from '../lib/ai/gateway';
import { clearCache } from '../lib/ai/cache';
import { refineMappingWithAi } from '../lib/migration/ai-assist';
import { saveSettingsSection, loadSettings } from '../lib/settings';

// One gateway for every model call: consent, per-unit limits, size cap, reuse, metering (real vs estimated tokens), estimate and before/after comparison. The provider here is a FAKE: its tokens are never real consumption.
const enabled = process.env.RUN_DB_TESTS === '1';

test('AI gateway', { skip: !enabled, timeout: 120_000 }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32); process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64'); process.env.RM_RESTAURANT_URL = 'https://r.example'; process.env.RM_ADMIN_URL = 'https://a.example';
  delete process.env.AI_DAILY_LIMIT;
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const sfx = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `gw ${sfx}`, slug: `gw-${sfx}`, status: 'ACTIVE' } });
  const [u1, u2] = await Promise.all([prisma.unit.create({ data: { tenantId: tenant.id, name: 'U1' } }), prisma.unit.create({ data: { tenantId: tenant.id, name: 'U2' } })]);
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, name: 'A', email: `a-${sfx}@t.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const cashier = await prisma.user.create({ data: { tenantId: tenant.id, name: 'C', email: `c-${sfx}@t.local`, passwordHash: 'x', role: UserRole.CASHIER } });
  const token = signAccessToken({ userId: admin.id, tenantId: tenant.id, unitId: null, role: UserRole.ADMIN });
  const cashierToken = signAccessToken({ userId: cashier.id, tenantId: tenant.id, unitId: null, role: UserRole.CASHIER });
  t.after(async () => { setAiProvider(undefined); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.tenant.deleteMany({ where: { id: tenant.id } }); await prisma.$disconnect(); });
  let calls = 0;
  const base1 = { settings: undefined, module: 'assistant', operation: 'test', system: 'sistema', question: 'pergunta', maxChars: 1000 };
  const ctx = (unitId: string | null) => ({ tenantId: tenant.id, unitId, userId: admin.id });
  setAiProvider({ name: 'fake', answer: async () => { calls++; return `resposta ${calls}`; } });
  clearCache(); resetBreaker();

  await t.test('no consent: nothing leaves; with consent: metered once, reused afterwards, estimated tokens flagged', async () => {
    const refused = await callModel({ ...base1, ctx: ctx(u1.id) });
    assert.equal(refused.ok, false); assert.equal(calls, 0);
    await saveSettingsSection(prisma, tenant.id, 'ai', { ...(await loadSettings(prisma, tenant.id)).ai, externalConsent: true });
    const first = await callModel({ ...base1, ctx: ctx(u1.id) });
    assert.ok(first.ok && first.source === 'model' && first.usage?.estimated === true, 'a provider that reports no tokens yields ESTIMATED tokens, flagged as such');
    const again = await callModel({ ...base1, ctx: ctx(u1.id) });
    assert.ok(again.ok && again.source === 'reuse'); assert.equal(calls, 1, 'identical request is not paid twice');
    const event = await prisma.aiUsageEvent.findFirstOrThrow({ where: { tenantId: tenant.id, kind: 'LLM' } }); assert.equal(event.tokensEstimated, true);
    const tooBig = await callModel({ ...base1, ctx: ctx(u1.id), question: 'x'.repeat(2000) });
    assert.ok(!tooBig.ok && tooBig.code === 'TOO_LARGE'); assert.equal(calls, 1, 'an oversized prompt is refused, not truncated and sent');
  });

  await t.test('per-unit limit blocks that unit only', async () => {
    const settings = await loadSettings(prisma, tenant.id);
    await saveSettingsSection(prisma, tenant.id, 'ai', { ...settings.ai, limits: { ...settings.ai.limits, llmCallsPerUnitDay: 2 } });
    assert.ok((await callModel({ ...base1, ctx: ctx(u1.id), question: 'q2' })).ok);
    const blocked = await callModel({ ...base1, ctx: ctx(u1.id), question: 'q3' });
    assert.ok(!blocked.ok && /desta unidade/.test(blocked.reason), JSON.stringify(blocked));
    assert.ok((await callModel({ ...base1, ctx: ctx(u2.id), question: 'q3' })).ok, 'another unit still has its own budget');
    assert.equal(await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id, kind: 'BLOCKED_LIMIT' } }), 1);
  });

  await t.test('migration mapping uses the same gate (consent/limits/metering) when given the company context', async () => {
    const before = await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id, module: 'migration', kind: 'LLM' } }); const callsBefore = calls;
    const tables = [{ name: 'produtos', file: 'p.csv', columns: ['xyz'], rowCount: 1, truncated: false, rows: [{ xyz: 'abc' }] }] as any;
    const mapping = { tables: { 'p.csv::produtos': { key: 'p.csv::produtos', entity: 'PRODUCT', columns: { xyz: { target: null, confidence: 0, level: 'none', reason: 'Sem correspondência', source: 'rule', needsReview: false } }, missingRequired: [] } } } as any;
    const profiles = new Map([['p.csv::produtos::xyz', { name: 'xyz', samples: ['abc'], nullRatio: 0, uniqueRatio: 1, avgLength: 3, dominant: 'text', ratios: {} }]]) as any;
    const refined = await refineMappingWithAi({ tables, mapping, profiles, gate: { tenantId: tenant.id, unitId: null, userId: admin.id } });
    assert.equal(await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id, module: 'migration', kind: 'LLM' } }), before + 1, 'the call is metered in the same table as every other model call');
    assert.equal(refined.applied, 0, 'an answer that is not the expected JSON is ignored: nothing is applied from it'); assert.ok(refined.warnings.length > 0);
    // Without consent the mapping falls back to the deterministic rules and sends nothing.
    await saveSettingsSection(prisma, tenant.id, 'ai', { ...(await loadSettings(prisma, tenant.id)).ai, externalConsent: false });
    const denied = await refineMappingWithAi({ tables, mapping, profiles, cache: {}, gate: { tenantId: tenant.id, unitId: null, userId: admin.id } });
    assert.ok(denied.warnings.some(item => /consentimento/.test(item))); assert.equal(calls, callsBefore + 1);
    await saveSettingsSection(prisma, tenant.id, 'ai', { ...(await loadSettings(prisma, tenant.id)).ai, externalConsent: true });
  });

  await t.test('estimate (no call, no recording) and before/after comparison; cashier gets no financial specialist', async () => {
    const before = await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id } });
    const estimate = await call('POST', '/ai/estimate', token, { question: 'como está o faturamento e a margem?' });
    assert.equal(estimate.status, 200); assert.ok(estimate.body.estimate.inputTokens > 0 && estimate.body.estimate.estimated === true && estimate.body.estimate.inputTokensMax >= estimate.body.estimate.inputTokens);
    assert.equal(await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id } }), before, 'an estimate records and sends nothing');
    const restricted = await call('POST', '/ai/estimate', cashierToken, { question: 'qual o lucro e o fluxo de caixa?' });
    assert.ok(!JSON.stringify(restricted.body.domains).match(/finance|profit|cash-flow|financeiro/i), JSON.stringify(restricted.body.domains));
    const compare = await call('GET', '/ai/usage/compare?days=7', token);
    assert.equal(compare.status, 200); assert.ok(compare.body.current.modelCalls >= 3); assert.ok(compare.body.current.estimatedTokens > 0 && compare.body.current.realTokens === 0, 'fake provider tokens are estimates, never real');
    assert.equal((await call('GET', '/ai/usage/compare', cashierToken)).status, 403);
    const usage = await call('GET', '/ai/usage', token); assert.equal(usage.body.tokens.real.tokens, 0); assert.ok(usage.body.tokens.estimated.tokens > 0);
  });
  await t.test('sales specialist: forecast/goal state their limits; CSV export follows the panel permissions and is audited', async () => {
    const panel = await call('GET', '/ai/domains/sales/panel', token);
    assert.equal(panel.status, 200); const data = panel.body.results[0].data;
    assert.equal(data.forecast.unavailable, true, 'no history: no invented forecast'); assert.match(data.forecast.reason, /Dados insuficientes/); assert.equal(data.goal.unavailable, true);
    await saveSettingsSection(prisma, tenant.id, 'intelligence', { ...(await loadSettings(prisma, tenant.id)).intelligence, monthlyGoal: 10000 });
    assert.equal((await call('GET', '/ai/domains/sales/panel', token)).body.results[0].data.goal.goal, 10000);
    const csv = await fetch(`${base}/ai/domains/sales/export.csv`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') ?? '', /text\/csv/); const text = await csv.text();
    assert.ok(text.includes('Especialista;') && text.includes('forecast.unavailable;sim'), text.slice(0, 600));
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: 'AI_EXPORT_CSV' } }), 1);
    const denied = await fetch(`${base}/ai/domains/sales/export.csv`, { headers: { authorization: `Bearer ${cashierToken}` } });
    assert.ok([403, 404].includes(denied.status)); assert.ok(!(await denied.text()).includes('revenue'), 'a profile without access gets no data');
    assert.equal((await fetch(`${base}/ai/domains/inexistente/export.csv`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  });
});
