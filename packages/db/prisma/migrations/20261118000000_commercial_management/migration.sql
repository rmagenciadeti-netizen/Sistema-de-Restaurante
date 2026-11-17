-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ModuleBilling" AS ENUM ('MONTHLY', 'ANNUAL', 'ONE_TIME', 'FREE');

-- CreateEnum
CREATE TYPE "CampaignAudience" AS ENUM ('NEW', 'EXISTING', 'BOTH');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaaSInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "PlanModule" ADD COLUMN     "optional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceOverride" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "SaaSPlan" ADD COLUMN     "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "conditions" TEXT,
ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "headline" TEXT,
ADD COLUMN     "highlight" TEXT,
ADD COLUMN     "originalPrice" DECIMAL(12,2),
ADD COLUMN     "promoPrice" DECIMAL(12,2),
ADD COLUMN     "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "TenantLicense" ADD COLUMN     "graceDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TenantModule" ADD COLUMN     "blocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "discountPercent" DECIMAL(5,2),
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "free" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'PLAN',
ADD COLUMN     "startsAt" TIMESTAMP(3),
ADD COLUMN     "unitPrice" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "SaaSModule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Geral',
    "icon" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "billing" "ModuleBilling" NOT NULL DEFAULT 'MONTHLY',
    "monthlyPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "annualPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "oneTimePrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "promoPrice" DECIMAL(12,2),
    "promoStartsAt" TIMESTAMP(3),
    "promoEndsAt" TIMESTAMP(3),
    "standalone" BOOLEAN NOT NULL DEFAULT true,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "discountValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "planIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moduleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "perTenantLimit" INTEGER,
    "audience" "CampaignAudience" NOT NULL DEFAULT 'BOTH',
    "cycles" INTEGER NOT NULL DEFAULT 1,
    "conditions" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "discountValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "planIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moduleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxUses" INTEGER,
    "perTenantLimit" INTEGER,
    "audience" "CampaignAudience" NOT NULL DEFAULT 'BOTH',
    "cycles" INTEGER NOT NULL DEFAULT 1,
    "minAmount" DECIMAL(12,2),
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSCouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT,
    "campaignId" TEXT,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSCouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSInvoice" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT,
    "reference" TEXT NOT NULL,
    "status" "SaaSInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "period" "BillingPeriod",
    "items" JSONB NOT NULL DEFAULT '[]',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "couponId" TEXT,
    "campaignId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "paidBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaaSModule_key_key" ON "SaaSModule"("key");

-- CreateIndex
CREATE INDEX "SaaSModule_status_category_idx" ON "SaaSModule"("status", "category");

-- CreateIndex
CREATE INDEX "SaaSCampaign_status_startsAt_endsAt_idx" ON "SaaSCampaign"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSCoupon_code_key" ON "SaaSCoupon"("code");

-- CreateIndex
CREATE INDEX "SaaSCouponRedemption_couponId_tenantId_idx" ON "SaaSCouponRedemption"("couponId", "tenantId");

-- CreateIndex
CREATE INDEX "SaaSCouponRedemption_campaignId_tenantId_idx" ON "SaaSCouponRedemption"("campaignId", "tenantId");

-- CreateIndex
CREATE INDEX "SaaSCouponRedemption_invoiceId_idx" ON "SaaSCouponRedemption"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSInvoice_seq_key" ON "SaaSInvoice"("seq");

-- CreateIndex
CREATE INDEX "SaaSInvoice_tenantId_status_dueDate_idx" ON "SaaSInvoice"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "SaaSInvoice_status_dueDate_idx" ON "SaaSInvoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "SaaSInvoice_paidAt_idx" ON "SaaSInvoice"("paidAt");

-- CreateIndex
CREATE INDEX "SaaSPlan_status_displayOrder_idx" ON "SaaSPlan"("status", "displayOrder");

-- AddForeignKey
ALTER TABLE "SaaSCouponRedemption" ADD CONSTRAINT "SaaSCouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "SaaSCoupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSCouponRedemption" ADD CONSTRAINT "SaaSCouponRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SaaSCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSCouponRedemption" ADD CONSTRAINT "SaaSCouponRedemption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSCouponRedemption" ADD CONSTRAINT "SaaSCouponRedemption_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SaaSInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSInvoice" ADD CONSTRAINT "SaaSInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSInvoice" ADD CONSTRAINT "SaaSInvoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSInvoice" ADD CONSTRAINT "SaaSInvoice_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "SaaSCoupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSInvoice" ADD CONSTRAINT "SaaSInvoice_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SaaSCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Active invoices are unique per tenant and competence; cancelled ones may be re-issued.
CREATE UNIQUE INDEX "SaaSInvoice_tenantId_reference_open_key" ON "SaaSInvoice"("tenantId", "reference") WHERE "status" <> 'CANCELLED';

-- Existing plans keep their availability.
UPDATE "SaaSPlan" SET "status" = 'INACTIVE' WHERE "active" = false;

-- Catalog of the technical features already enforced by the API (prices are managed in RM Painel Admin).
INSERT INTO "SaaSModule" ("id", "key", "name", "description", "category", "icon", "updatedAt") VALUES
  (gen_random_uuid(), 'pos', 'PDV e Pedidos', 'PDV, comandas, pedidos e carrinho de mesa', 'Operação', '🖥️', now()),
  (gen_random_uuid(), 'tables', 'Gestão de Mesas e Reservas', 'Mapa de mesas, QR Code e reservas', 'Operação', '🪑', now()),
  (gen_random_uuid(), 'delivery', 'Delivery', 'Central de delivery, zonas e entregadores', 'Operação', '🛵', now()),
  (gen_random_uuid(), 'kds', 'KDS e Setores de Produção', 'Painel de produção por setor', 'Operação', '👨‍🍳', now()),
  (gen_random_uuid(), 'printing', 'Impressão', 'Impressoras, setores e agente de impressão', 'Operação', '🖨️', now()),
  (gen_random_uuid(), 'inventory', 'Estoque e Compras', 'Estoque, ficha técnica, fornecedores e compras', 'Gestão', '📦', now()),
  (gen_random_uuid(), 'financial', 'Financeiro e Caixas', 'Contas a pagar/receber, caixa e formas de pagamento', 'Gestão', '💰', now()),
  (gen_random_uuid(), 'employees', 'Funcionários, Escalas e Comissões', 'Equipe, escalas e comissões', 'Gestão', '👥', now()),
  (gen_random_uuid(), 'reports', 'Relatórios Avançados', 'Central de relatórios e exportações', 'Gestão', '📊', now()),
  (gen_random_uuid(), 'fiscal', 'Documentos Fiscais', 'NF-e, NFC-e e regras tributárias', 'Fiscal', '📄', now()),
  (gen_random_uuid(), 'marketing', 'Cupons e Promoções', 'Cupons, promoções e fidelização de clientes', 'Relacionamento', '🏷️', now()),
  (gen_random_uuid(), 'whatsapp', 'WhatsApp', 'Atendimento e pedidos via WhatsApp', 'Relacionamento', '💬', now()),
  (gen_random_uuid(), 'integrations', 'Integrações e Pagamentos', 'PIX, POS e marketplaces', 'Integrações', '🔌', now()),
  (gen_random_uuid(), 'intelligence', 'RM Inteligência', 'Assistente, previsões e alertas com os dados reais do restaurante', 'Inteligência', '🧠', now())
ON CONFLICT ("key") DO NOTHING;

-- Initial plans as drafts without prices: the administrator sets prices, limits and publishes them.
INSERT INTO "SaaSPlan" ("id", "key", "name", "description", "active", "status", "displayOrder", "updatedAt") VALUES
  (gen_random_uuid(), 'rm-start', 'RM START', 'Para pequenos estabelecimentos', false, 'DRAFT', 1, now()),
  (gen_random_uuid(), 'rm-pro', 'RM PRO', 'Para restaurantes em crescimento', false, 'DRAFT', 2, now()),
  (gen_random_uuid(), 'rm-premium', 'RM PREMIUM', 'Para estabelecimentos maiores e redes', false, 'DRAFT', 3, now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlanModule" ("id", "planId", "moduleKey")
SELECT gen_random_uuid(), p."id", m.key FROM "SaaSPlan" p
JOIN (VALUES
  ('rm-start','pos'),('rm-start','tables'),('rm-start','inventory'),('rm-start','financial'),('rm-start','fiscal'),
  ('rm-pro','pos'),('rm-pro','tables'),('rm-pro','inventory'),('rm-pro','financial'),('rm-pro','fiscal'),('rm-pro','kds'),('rm-pro','delivery'),('rm-pro','marketing'),('rm-pro','reports'),('rm-pro','employees'),('rm-pro','printing'),
  ('rm-premium','pos'),('rm-premium','tables'),('rm-premium','inventory'),('rm-premium','financial'),('rm-premium','fiscal'),('rm-premium','kds'),('rm-premium','delivery'),('rm-premium','marketing'),('rm-premium','reports'),('rm-premium','employees'),('rm-premium','printing'),('rm-premium','intelligence'),('rm-premium','integrations'),('rm-premium','whatsapp')
) AS m(plan, key) ON m.plan = p."key"
ON CONFLICT ("planId", "moduleKey") DO NOTHING;
