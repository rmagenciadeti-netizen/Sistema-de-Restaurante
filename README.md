# RM Restaurant SaaS

Plataforma ERP SaaS para gestão de restaurantes, bares, lanchonetes, pizzarias, delivery e operações multiempresa.

## Visão geral

Este repositório inicial implementa a base arquitetural do projeto conforme a especificação funcional de RM Restaurant SaaS:

- Monólito modular com domínios bem delimitados
- Multi-tenant com isolamento por empresa e unidade
- Frontend em Next.js + React + TypeScript + Tailwind
- Backend em TypeScript com API REST versionada
- Base de dados PostgreSQL com Prisma
- Docker e Docker Compose para desenvolvimento/local
- Estrutura preparada para PDV, produção, financeiro, delivery, fiscal e SaaS Admin

## Estrutura proposta

```text
.
├─ apps/
│  ├─ api/
│  │  └─ src/
│  └─ web/
│     └─ app/
├─ packages/
│  ├─ db/
│  │  └─ prisma/
│  └─ shared/
├─ docker-compose.yml
├─ .env.example
├─ .gitignore
├─ package.json
└─ README.md
```

## Stack recomendada

- Frontend: Next.js, React, TypeScript, Tailwind CSS
- Backend: TypeScript, Express/Fastify, API REST versionada
- Banco: PostgreSQL
- ORM: Prisma
- Armazenamento: S3 compatível (MinIO em dev)
- Filas: pg-boss (baseado em PostgreSQL)
- Infra: Docker, Docker Compose
- Documentação: OpenAPI/Swagger

## Módulos iniciais

- Master SaaS Admin
- Multiempresa e multiunidade
- Restaurante / cadastro operacional
- Funcionários e permissões
- PDV e comandas
- Produtos, categorias e adicionais
- Produção e KDS
- Estoque, compras e fornecedores
- Financeiro e contas
- Delivery, WhatsApp e CRM
- Fiscal e integrações
- Relatórios e auditoria

## Como executar

### 1) Instalar dependências

```bash
npm install
```

### 2) Subir infraestrutura local

```bash
docker compose up -d postgres minio
```

### 3) Rodar backend

```bash
npm --workspace apps/api run dev
```

### 4) Rodar frontend

```bash
npm --workspace apps/web run dev
```

## Observações

Esta estrutura é um ponto de partida para a implementação real do ERP. Os módulos, schemas, regras de negócio e integrações devem evoluir seguindo a especificação funcional principal do projeto.

## Próximos passos recomendados

1. Definir modelos de domínio multi-tenant
2. Implementar autenticação e autorização por tenant
3. Construir módulo de empresas/unidades
4. Criar cadastro de produtos e setores de produção
5. Implementar PDV e comandas
6. Adicionar módulo fiscal e financeiro
7. Integrar WhatsApp, delivery e CRM
8. Criar relatórios e dashboards

