# Backup do PostgreSQL (Neon)

## O que existe
| Camada | O que cobre | Estado |
|---|---|---|
| **Neon PITR (instant restore)** | Volta o banco a qualquer instante da janela do plano (Free 6 h, Launch 7 dias, Scale 30 dias). Nativo do provedor, sem agendamento. | Depende do plano contratado no Neon. |
| **Backup lógico agendado** | `pg_dump` noturno, criptografado (AES-256), com checksum e validação `pg_restore --list`, enviado a um bucket S3 compatível, por tempo ilimitado. | Pronto no repositório, **desligado** até configurar (abaixo). |
| **Backup por migração** | `.rmbk` por restaurante antes de cada RM Smart Migration, com restauração de prova. | Já em uso (ver README). |

O Neon não tem agendador próprio de dumps; a recomendação oficial dele é `pg_dump` + GitHub Actions + S3. Foi o que se preparou:
[`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml) (diário às 02:17 de Brasília, mais disparo manual) usando [`scripts/backup/pg-backup.sh`](../scripts/backup/pg-backup.sh).

## Ativação (ação externa, uma única vez)
1. No Neon, copie a connection string **direta** (sem `-pooler`), de preferência de um papel somente leitura.
2. No bucket S3 (ou R2/Backblaze compatível), crie um usuário com permissão apenas de `PutObject` no prefixo de backups.
3. No GitHub › Settings › Secrets and variables › Actions:
   - Secrets: `BACKUP_DATABASE_URL`, `BACKUP_ENCRYPT_PASSPHRASE` (guarde-a em cofre separado: sem ela o backup não abre), `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`.
   - Variables: `BACKUP_S3_URI` (ex.: `s3://meu-bucket/rm-restaurant`), `BACKUP_S3_REGION`, e por fim `BACKUP_ENABLED=true`.
4. Rode o workflow uma vez em *Actions › Backup PostgreSQL › Run workflow* e confira o objeto no bucket.
5. Defina no bucket uma regra de ciclo de vida (retenção) conforme a política da empresa.

## Prova de restauração
Backup só vale se restaura. Em um servidor **de teste** (nunca produção):
```bash
SOURCE_URL="$DATABASE_URL" RESTORE_URL="postgresql://.../postgres" BACKUP_ENCRYPT_PASSPHRASE=... \
  bash scripts/backup/pg-restore-check.sh rm-restaurant-AAAAMMDDThhmmssZ.dump.enc
```
O script restaura num banco descartável e compara a contagem de linhas de cada tabela. Repita a prova periodicamente (sugestão: mensal).

## Execução fora do GitHub
O mesmo script roda em qualquer agendador (cron/systemd): `DATABASE_URL=... BACKUP_DIR=/var/backups/rm BACKUP_ENCRYPT_PASSPHRASE=... scripts/backup/pg-backup.sh`.

## Limites
- O `pg-backup.sh` foi executado contra o banco de desenvolvimento local (dump criptografado, checksum conferido e conteúdo listável após decifrar). O workflow do GitHub nunca rodou: exige os segredos acima e acesso ao Neon, e a instalação do cliente PostgreSQL 16 nele não foi testada.
- Backup protege contra perda do banco; não substitui controle de acesso nem a janela PITR.
