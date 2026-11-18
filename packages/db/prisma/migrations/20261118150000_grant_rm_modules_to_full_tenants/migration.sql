-- Tenants provisioned before RM Inteligência / RM Controle de Lucro existed hold every legacy module (full access).
-- They keep full access: grant the two new modules to them. Tenants with a restricted module set are untouched.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "source")
SELECT gen_random_uuid()::text, legacy."tenantId", new_module.key, 'PLAN'
FROM (
  SELECT "tenantId"
  FROM "TenantModule"
  WHERE "moduleKey" IN ('pos', 'tables', 'delivery', 'inventory', 'financial', 'employees', 'kds', 'printing', 'whatsapp', 'marketing', 'fiscal', 'reports', 'integrations') AND "blocked" = false
  GROUP BY "tenantId"
  HAVING COUNT(DISTINCT "moduleKey") = 13
) AS legacy
CROSS JOIN (VALUES ('intelligence'), ('profit')) AS new_module(key)
ON CONFLICT ("tenantId", "moduleKey") DO NOTHING;
