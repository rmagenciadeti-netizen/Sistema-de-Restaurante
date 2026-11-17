import os from 'node:os';
import { MessageStatus, Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { findOrCreateConversation, processInbound, recordOutbound } from './whatsapp-inbound';
import { isOptedOut, renderStored, toWhatsappDigits } from './whatsapp-auto';
import { autoMessageDef } from './whatsapp-messages';
import { defaultTransportFactory, wipeAuth, type InboundMessage, type TransportFactory, type WaTransport } from './whatsapp-transport';

export const MANAGER_STALE_MS = 20_000;
const MESSAGE_TTL_MS = 60 * 60 * 1000;
const MAX_PER_MINUTE = 20;
const MAX_UNCONFIRMED_CLOSES = 4;

type Live = { transport: WaTransport; connected: boolean; unconfirmedCloses: number; sentAt: number[]; chain: Promise<void> };
type Options = { factory?: TransportFactory; pollMs?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void };

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Owns every WhatsApp socket of this deployment. Coordinates with the API only through the WhatsappSession rows:
// the API writes `desired`; the manager writes status/qr/phone. Run exactly one manager (worker or API process).
export class WhatsappSessionManager {
  private readonly live = new Map<string, Live>();
  private readonly retryAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly factory: TransportFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly prisma: PrismaClient, private readonly options: Options = {}) {
    this.factory = options.factory ?? defaultTransportFactory;
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (message => console.log(`[whatsapp] ${message}`));
  }

  async start() {
    const owner = await this.prisma.whatsappManager.findUnique({ where: { id: 'default' } });
    const mine = { pid: process.pid, host: os.hostname() };
    if (owner && Date.now() - owner.heartbeatAt.getTime() < MANAGER_STALE_MS && (owner.pid !== mine.pid || owner.host !== mine.host)) {
      throw new Error(`Another WhatsApp session manager is already running (pid ${owner.pid} on ${owner.host}). Run only one (worker or API).`);
    }
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (error) { this.log(`tick error: ${error instanceof Error ? error.message : String(error)}`); }
      if (this.running) this.timer = setTimeout(() => void loop(), this.options.pollMs ?? 2000);
    };
    await loop();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const [tenantId, entry] of this.live) { await entry.transport.stop().catch(() => undefined); this.live.delete(tenantId); }
  }

  liveTenantIds() { return [...this.live.keys()]; }
  connectedTenantIds() { return [...this.live.entries()].filter(([, entry]) => entry.connected).map(([tenantId]) => tenantId); }

  async tick() {
    const mine = { pid: process.pid, host: os.hostname() };
    await this.prisma.whatsappManager.upsert({ where: { id: 'default' }, create: { id: 'default', heartbeatAt: new Date(), ...mine }, update: { heartbeatAt: new Date(), ...mine } });
    const rows = await this.prisma.whatsappSession.findMany();
    for (const row of rows) {
      const entry = this.live.get(row.tenantId);
      if (row.desired === 'LOGOUT') {
        if (entry) { this.live.delete(row.tenantId); await entry.transport.stop({ logout: true }).catch(() => undefined); }
        wipeAuth(row.tenantId); this.failures.delete(row.tenantId); this.retryAt.delete(row.tenantId);
        await this.prisma.whatsappSession.update({ where: { tenantId: row.tenantId }, data: { desired: 'DISCONNECTED', status: 'LOGGED_OUT', qr: null, phone: null, pushName: null, connectedAt: null, lastError: null } });
      } else if (row.desired === 'CONNECTED') {
        if (!entry && (this.retryAt.get(row.tenantId) ?? 0) <= Date.now()) await this.connect(row.tenantId);
      } else if (entry) {
        this.live.delete(row.tenantId); await entry.transport.stop().catch(() => undefined);
        await this.prisma.whatsappSession.update({ where: { tenantId: row.tenantId }, data: { status: 'DISCONNECTED', qr: null } });
      }
    }
    await this.processOutbox();
  }

  private async setSession(tenantId: string, data: Prisma.WhatsappSessionUpdateInput) {
    await this.prisma.whatsappSession.update({ where: { tenantId }, data }).catch(() => undefined);
  }

  private async connect(tenantId: string) {
    const transport = this.factory(tenantId);
    const entry: Live = { transport, connected: false, unconfirmedCloses: this.failures.get(tenantId) ?? 0, sentAt: [], chain: Promise.resolve() };
    this.live.set(tenantId, entry);
    await this.setSession(tenantId, { status: 'CONNECTING', qr: null });
    try {
      await transport.start({
        onQr: qr => { void this.setSession(tenantId, { status: 'QR_READY', qr, lastError: null }); },
        onOpen: info => {
          entry.connected = true; entry.unconfirmedCloses = 0; this.failures.delete(tenantId);
          this.log(`tenant ${tenantId} connected as ${info.phone}`);
          void this.setSession(tenantId, { status: 'CONNECTED', qr: null, phone: info.phone, pushName: info.name, connectedAt: new Date(), lastError: null });
        },
        onClose: info => { void this.handleClose(tenantId, entry, info); },
        onMessage: message => { entry.chain = entry.chain.then(() => this.handleMessage(tenantId, entry, message)).catch(error => this.log(`message error: ${error instanceof Error ? error.message : String(error)}`)); },
      });
    } catch (error) {
      this.live.delete(tenantId);
      await this.failConnection(tenantId, entry, error instanceof Error ? error.message : 'START_FAILED');
    }
  }

  private async failConnection(tenantId: string, entry: Live, reason: string) {
    const attempts = entry.unconfirmedCloses + 1;
    this.failures.set(tenantId, attempts);
    // After several QR cycles nobody scanned: stop instead of generating codes forever.
    if (!entry.connected && attempts >= MAX_UNCONFIRMED_CLOSES) {
      this.failures.delete(tenantId); this.retryAt.delete(tenantId);
      await this.setSession(tenantId, { desired: 'DISCONNECTED', status: 'DISCONNECTED', qr: null, lastError: 'O QR Code expirou sem ser lido. Clique em Conectar para gerar outro.' });
      return;
    }
    this.retryAt.set(tenantId, Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5)));
    await this.setSession(tenantId, { status: 'CONNECTING', lastError: reason.slice(0, 300) });
  }

  private async handleClose(tenantId: string, entry: Live, info: { loggedOut: boolean; error?: string }) {
    if (this.live.get(tenantId) !== entry) return;
    this.live.delete(tenantId);
    await entry.transport.stop().catch(() => undefined);
    if (info.loggedOut) {
      wipeAuth(tenantId); this.failures.delete(tenantId); this.retryAt.delete(tenantId);
      this.log(`tenant ${tenantId} logged out from the phone`);
      await this.setSession(tenantId, { desired: 'DISCONNECTED', status: 'LOGGED_OUT', qr: null, phone: null, pushName: null, connectedAt: null, lastError: 'A sessão foi encerrada pelo celular. Conecte novamente.' });
      return;
    }
    if (entry.connected) { this.failures.delete(tenantId); this.retryAt.set(tenantId, Date.now() + 2_000); await this.setSession(tenantId, { status: 'CONNECTING', lastError: info.error?.slice(0, 300) ?? null }); return; }
    await this.failConnection(tenantId, entry, info.error ?? 'CONNECTION_CLOSED');
  }

  private async throttle(entry: Live) {
    const now = Date.now();
    entry.sentAt = entry.sentAt.filter(time => now - time < 60_000);
    if (entry.sentAt.length >= MAX_PER_MINUTE) await this.sleep(60_000 - (now - entry.sentAt[0]) + 50);
    entry.sentAt.push(Date.now());
  }

  private async handleMessage(tenantId: string, entry: Live, message: InboundMessage) {
    if (message.timestamp && Date.now() / 1000 - message.timestamp > 120) return;
    const outcome = await processInbound(this.prisma, { tenantId, jid: message.jid, phone: message.phone, name: message.name, text: message.text, externalId: message.id });
    if (!outcome.conversationId || outcome.replies.length === 0) return;
    const settings = await loadSettings(this.prisma, tenantId);
    for (const reply of outcome.replies) {
      await this.throttle(entry);
      const typingMs = settings.whatsapp.humanizeTyping ? Math.min(4000, 600 + reply.length * 15) : 0;
      if (settings.whatsapp.replyDelaySeconds > 0) await this.sleep(settings.whatsapp.replyDelaySeconds * 1000);
      try {
        const id = await entry.transport.sendText(message.jid, reply, { typingMs });
        await recordOutbound(this.prisma, tenantId, outcome.conversationId, reply, 'BOT', id);
      } catch (error) { this.log(`reply failed: ${error instanceof Error ? error.message : String(error)}`); break; }
    }
  }

  // Sends queued messages (automatic notices and staff replies) for tenants whose QR session is connected.
  async processOutbox(limit = 20) {
    const tenantIds = this.connectedTenantIds();
    if (tenantIds.length === 0) return { sent: 0, failed: 0 };
    const batch = await this.prisma.whatsappMessage.findMany({ where: { status: MessageStatus.QUEUED, tenantId: { in: tenantIds }, toPhone: { not: 'redacted' } }, orderBy: { createdAt: 'asc' }, take: limit });
    let sent = 0; let failed = 0;
    const fail = async (id: string, error: string) => { failed += 1; await this.prisma.whatsappMessage.update({ where: { id }, data: { status: MessageStatus.FAILED, error } }); };
    for (const message of batch) {
      const entry = this.live.get(message.tenantId);
      if (!entry?.connected) continue;
      if (Date.now() - message.createdAt.getTime() > MESSAGE_TTL_MS) { await fail(message.id, 'EXPIRED'); continue; }
      const payload = (message.payload && typeof message.payload === 'object' ? message.payload : {}) as Record<string, unknown>;
      const freeText = message.template === 'free_text';
      let body: string;
      if (freeText) body = String(payload.text ?? '').trim();
      else {
        const def = autoMessageDef(message.template);
        if (!def) { await fail(message.id, 'UNKNOWN_TEMPLATE'); continue; }
        const [settings, override] = await Promise.all([loadSettings(this.prisma, message.tenantId), this.prisma.whatsappAutoMessage.findUnique({ where: { tenantId_key: { tenantId: message.tenantId, key: def.key } } })]);
        if (!settings.whatsapp.autoMessagesEnabled || !(override ? override.enabled : def.defaultEnabled)) { await fail(message.id, 'DISABLED'); continue; }
        if (await isOptedOut(this.prisma, message.tenantId, message.toPhone)) { await fail(message.id, 'OPT_OUT'); continue; }
        body = renderStored(override?.body ?? def.defaultBody, { nome: payload.customerName ?? '', pedido: payload.orderCode ?? '', ...payload } as unknown as Record<string, string | number>);
      }
      if (!body) { await fail(message.id, 'EMPTY_MESSAGE'); continue; }
      try {
        const jid = await entry.transport.resolveJid(toWhatsappDigits(message.toPhone));
        if (!jid) { await fail(message.id, 'NOT_ON_WHATSAPP'); continue; }
        await this.throttle(entry);
        const id = await entry.transport.sendText(jid, body, { typingMs: 0 });
        await this.prisma.whatsappMessage.update({ where: { id: message.id }, data: { status: MessageStatus.SENT, providerRef: id, sentAt: new Date() } });
        const conversation = await findOrCreateConversation(this.prisma, message.tenantId, jid, jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null, null);
        await recordOutbound(this.prisma, message.tenantId, conversation.id, body, freeText ? 'STAFF' : 'AUTO', id);
        sent += 1;
      } catch (error) { await fail(message.id, (error instanceof Error ? error.message : 'SEND_FAILED').slice(0, 300)); }
    }
    return { sent, failed };
  }
}

// Mode: 'api' runs the manager inside the API process (default outside production); 'worker' leaves it to `npm run worker`; 'off' disables QR sessions.
export function whatsappSessionsMode(env: NodeJS.ProcessEnv = process.env): 'api' | 'worker' | 'off' {
  const value = env.WHATSAPP_SESSIONS_MODE;
  if (value === 'api' || value === 'worker' || value === 'off') return value;
  return env.NODE_ENV === 'production' ? 'worker' : 'api';
}
