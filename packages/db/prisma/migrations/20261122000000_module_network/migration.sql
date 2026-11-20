-- Gestão Multiunidades (/network, preço por unidade) passa a ser um módulo do catálogo. Até aqui qualquer empresa com licença usava essas
-- rotas, então todas as empresas que já têm licença recebem o módulo: ninguém perde acesso. Planos, preços, mensalidades e demais módulos
-- não são alterados; sem licença a empresa continua com tudo aberto.
INSERT INTO "SaaSModule" ("id", "key", "name", "description", "category", "icon", "updatedAt") VALUES
  (gen_random_uuid(), 'network', 'Gestão Multiunidades e Rede', 'Comparação e consolidado entre unidades e preço por unidade', 'Gestão', '🏢', now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "source")
SELECT gen_random_uuid()::text, l."tenantId", 'network', 'PLAN'
FROM "TenantLicense" l
ON CONFLICT ("tenantId", "moduleKey") DO NOTHING;
