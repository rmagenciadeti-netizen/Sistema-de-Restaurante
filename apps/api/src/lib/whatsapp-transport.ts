import path from 'node:path';
import fs from 'node:fs';

export type InboundMessage = { jid: string; phone: string | null; name: string | null; text: string; id: string | null; timestamp: number | null };
export type TransportHandlers = {
  onQr(qr: string): void;
  onOpen(info: { phone: string | null; name: string | null }): void;
  onClose(info: { loggedOut: boolean; error?: string }): void;
  onMessage(message: InboundMessage): void;
};

// One live connection to WhatsApp Web for one tenant. The manager only depends on this interface, so tests use a fake.
export interface WaTransport {
  start(handlers: TransportHandlers): Promise<void>;
  sendText(jid: string, text: string, options?: { typingMs?: number }): Promise<string | null>;
  resolveJid(digits: string): Promise<string | null>;
  stop(options?: { logout?: boolean }): Promise<void>;
}
export type TransportFactory = (tenantId: string) => WaTransport;

export const sessionsDir = () => path.resolve(process.env.WHATSAPP_SESSION_DIR || path.join(process.cwd(), '.whatsapp-sessions'));
export const authDirFor = (tenantId: string) => path.join(sessionsDir(), tenantId.replace(/[^a-zA-Z0-9-]/g, ''));
export const wipeAuth = (tenantId: string) => fs.rmSync(authDirFor(tenantId), { recursive: true, force: true });

const digitsOf = (jid: string | null | undefined) => (jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0].replace(/\D/g, '') : null);

type BaileysMessage = { key: { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null; id?: string | null }; pushName?: string | null; messageTimestamp?: number | { toNumber(): number } | null; message?: Record<string, any> | null };

export function extractText(message: BaileysMessage['message']): string {
  if (!message) return '';
  const inner = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  return inner.conversation ?? inner.extendedTextMessage?.text ?? inner.buttonsResponseMessage?.selectedDisplayText ?? inner.listResponseMessage?.title ?? inner.templateButtonReplyMessage?.selectedDisplayText ?? '';
}

// Unofficial WhatsApp Web client (Baileys). Credentials live on disk in `authDirFor(tenantId)`; treat that folder like a password.
export class BaileysTransport implements WaTransport {
  private sock: any = null;
  constructor(private readonly authDir: string) {}

  async start(handlers: TransportHandlers): Promise<void> {
    const baileys: any = await import('@whiskeysockets/baileys');
    const makeSocket = baileys.default?.default ?? baileys.default ?? baileys.makeWASocket;
    const pino = (await import('pino')).default;
    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authDir);
    const latest = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeSocket({ version: latest.version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['RM Restaurant', 'Chrome', '1.0.0'], markOnlineOnConnect: false, syncFullHistory: false });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update: { connection?: string; qr?: string; lastDisconnect?: { error?: { message?: string; output?: { statusCode?: number } } } }) => {
      if (update.qr) handlers.onQr(update.qr);
      if (update.connection === 'open') handlers.onOpen({ phone: digitsOf(sock.user?.id ?? null) ?? (sock.user?.id ? String(sock.user.id).split(':')[0].split('@')[0] : null), name: sock.user?.name ?? null });
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        handlers.onClose({ loggedOut: code === baileys.DisconnectReason.loggedOut, error: update.lastDisconnect?.error?.message });
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }: { messages: BaileysMessage[]; type: string }) => {
      if (type !== 'notify') return;
      for (const item of messages) {
        const jid = item.key.remoteJid;
        if (!jid || item.key.fromMe || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
        const text = extractText(item.message).trim();
        if (!text) continue;
        const ts = item.messageTimestamp;
        handlers.onMessage({ jid, phone: digitsOf(jid) ?? digitsOf(item.key.remoteJidAlt), name: item.pushName ?? null, text, id: item.key.id ?? null, timestamp: ts == null ? null : typeof ts === 'number' ? ts : ts.toNumber() });
      }
    });
  }

  async sendText(jid: string, text: string, options: { typingMs?: number } = {}): Promise<string | null> {
    if (!this.sock) throw new Error('NOT_CONNECTED');
    if (options.typingMs && options.typingMs > 0) {
      await this.sock.presenceSubscribe(jid).catch(() => undefined);
      await this.sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, options.typingMs));
      await this.sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
    }
    const sent = await this.sock.sendMessage(jid, { text });
    return sent?.key?.id ?? null;
  }

  async resolveJid(digits: string): Promise<string | null> {
    if (!this.sock) throw new Error('NOT_CONNECTED');
    const [found] = (await this.sock.onWhatsApp(digits)) ?? [];
    return found?.exists ? found.jid : null;
  }

  async stop(options: { logout?: boolean } = {}): Promise<void> {
    const sock = this.sock; this.sock = null;
    if (!sock) return;
    try {
      if (options.logout) await sock.logout();
      else sock.end(undefined);
    } catch { /* already closed */ }
  }
}

export const defaultTransportFactory: TransportFactory = tenantId => new BaileysTransport(authDirFor(tenantId));
