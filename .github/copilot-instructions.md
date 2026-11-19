# Instruções de Execução para o GitHub Copilot

## 1. Testes e Validação (Evitar travamentos)
- Ao validar alterações, execute **apenas** os testes unitários específicos dos arquivos que você modificou.
- Sempre adicione a flag `--test-force-exit` ao rodar testes com Node (`node --import tsx --test --test-force-exit <caminho-do-teste>`), evitando que conexões abertas travem o terminal.
- **Não** execute a suíte completa de testes de integração a cada pequena alteração.

## 2. Banco de Dados e Ambiente
- **Nunca** execute comandos de deploy ou migração em banco remoto (`npm run db:deploy`, `db:push` ou scripts que dependam de conexão externa com o Neon/PostgreSQL) durante o desenvolvimento.
- Caso precise validar esquemas, utilize apenas comandos locais como `npm run db:generate` ou `npm run db:validate`.

## 3. Build e Fluxo de Trabalho
- Verifique tipagem e lint apenas no workspace específico alterado (`apps/web`, `apps/admin` ou `apps/print-agent`) em vez de rodar o build completo do monorepo inteiro toda vez.
- Divida implementações grandes em etapas menores e faça commits funcionais frequentes para não perder progresso caso o tempo da sessão acabe.
