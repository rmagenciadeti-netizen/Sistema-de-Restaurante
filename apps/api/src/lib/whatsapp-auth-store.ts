import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { openWith, sealWith } from './secret-box';

// Where the WhatsApp pairing (credentials + Signal keys) of one restaurant lives. The default store is the database, encrypted: the pairing then
// survives deploys, restarts and moving the worker, and each restaurant only ever reads its own rows. The file store is kept for local use/tests.
export interface AuthStore {
  load(baileys: any): Promise<{ state: any; saveCreds: () => Promise<void> }>;
  wipe(): Promise<void>;
}

const AUTH_KEYS = ['WHATSAPP_AUTH_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY'];
export const encryptAuth = (plain: string) => sealWith('rm-whatsapp-auth', AUTH_KEYS, plain);
export const decryptAuth = (payload: string) => openWith('rm-whatsapp-auth', AUTH_KEYS, payload);

export class DbAuthStore implements AuthStore {
  constructor(private readonly prisma: PrismaClient, private readonly tenantId: string) {}

  async load(baileys: any) {
    const { initAuthCreds, BufferJSON, proto } = baileys;
    const { prisma, tenantId } = this;
    const read = async (name: string) => {
      const row = await prisma.whatsappAuthKey.findUnique({ where: { tenantId_name: { tenantId, name } } });
      if (!row) return null;
      try { return JSON.parse(decryptAuth(row.value), BufferJSON.reviver); } catch { return null; }
    };
    const write = (name: string, value: unknown) => {
      const encrypted = encryptAuth(JSON.stringify(value, BufferJSON.replacer));
      return prisma.whatsappAuthKey.upsert({ where: { tenantId_name: { tenantId, name } }, create: { tenantId, name, value: encrypted }, update: { value: encrypted } });
    };
    const creds = (await read('creds')) ?? initAuthCreds();
    return {
      state: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            const data: Record<string, unknown> = {};
            await Promise.all(ids.map(async id => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[id] = value;
            }));
            return data;
          },
          set: async (data: Record<string, Record<string, unknown>>) => {
            const tasks: Promise<unknown>[] = [];
            for (const category of Object.keys(data)) for (const id of Object.keys(data[category])) {
              const value = data[category][id]; const name = `${category}-${id}`;
              tasks.push(value ? write(name, value) : prisma.whatsappAuthKey.deleteMany({ where: { tenantId, name } }));
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => { await write('creds', creds); },
    };
  }

  async wipe() { await this.prisma.whatsappAuthKey.deleteMany({ where: { tenantId: this.tenantId } }); }
}

export const sessionsDir = () => path.resolve(process.env.WHATSAPP_SESSION_DIR || path.join(process.cwd(), '.whatsapp-sessions'));
export const authDirFor = (tenantId: string) => path.join(sessionsDir(), tenantId.replace(/[^a-zA-Z0-9-]/g, ''));

export class FileAuthStore implements AuthStore {
  constructor(private readonly dir: string) {}
  async load(baileys: any) { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); return baileys.useMultiFileAuthState(this.dir); }
  async wipe() { fs.rmSync(this.dir, { recursive: true, force: true }); }
}

export const authStoreFor = (prisma: PrismaClient, tenantId: string): AuthStore => (process.env.WHATSAPP_AUTH_STORE === 'file' ? new FileAuthStore(authDirFor(tenantId)) : new DbAuthStore(prisma, tenantId));
// Removes the pairing wherever it may be (database and the legacy folder), used on logout.
export async function wipeAllAuth(prisma: PrismaClient, tenantId: string) {
  await new DbAuthStore(prisma, tenantId).wipe().catch(() => undefined);
  await new FileAuthStore(authDirFor(tenantId)).wipe().catch(() => undefined);
}
