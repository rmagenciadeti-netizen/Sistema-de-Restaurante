import os from 'node:os';
import { MessageStatus, Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { findOrCreateConversation, answerInbound, recordOutbound, storeInbound, type InboundInput, type StoredInbound } from './whatsapp-inbound';
import { isOptedOut, renderStored, toWhatsappDigits } from './whatsapp-auto';
import { autoMessageDef } from './whatsapp-messages';
import { effectiveModules, globallyBlockedModules, licenseDenial } from './licensing';
import { wipeAllAuth } from './whatsapp-auth-store';
import { defaultTransportFactory, type InboundMessage, type TransportFactory, type WaTransport } from './whatsapp-transport';

export const MANAGER_STALE_MS = 20_000;
const MESSAGE_TTL_MS = 60 * 60 * 1000;
const MAX_PER_MINUTE = 20;
const MAX_UNCONFIRMED_CLOSES = 4;
// While someone is looking at the connection screen the QR Code keeps being renewed (Baileys rotates it every ~20 s and closes after ~1 min).
export const VIEWER_ACTIVE_MS = 3 * 60_000;
const MAX_SESSIONS = () => Math.max(1, Number(process.env.WHATSAPP_MAX_SESSIONS) || 25);

type Live = { transport: WaTransport; connected: boolean; unconfirmedCloses: number; sentAt: number[]; chains: Map<string, Promise<void>>; storing: Map<string, Promise<unknown>> };
type Options = { factory?: TransportFactory; pollMs?: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void; identity?: { pid: number; host: string }; lockId?: string; tenantIds?: string[] };

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

  private leader = false;
  private readonly me: { pid: number; host: string };
  private readonly lockId: string;
  private readonly only?: string[];

  constructor(private readonly prisma: PrismaClient, private readonly options: Options = {}) {
    this.lockId = options.lockId ?? 'default';
    this.only = options.tenantIds;
    this.me = options.identity ?? { pid: process.pid, host: os.hostname() };
    this.factory = options.factory ?? defaultTransportFactory(prisma);
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (message => console.log(`[whatsapp] ${message}`));
  }

  // Several processes (API and worker) may run a manager: only the holder of the WhatsappManager row operates the sockets, the others stand by and
  // take over when its heartbeat goes stale (crash) or is released (deploy). Two sockets for the same account would kick each other out.
  async start() {
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
    // Hand over immediately instead of making the next instance wait for the heartbeat to go stale.
    if (this.leader) await this.prisma.whatsappManager.updateMany({ where: { id: this.lockId, ...this.me }, data: { heartbeatAt: new Date(0) } }).catch(() => undefined);
    this.leader = false;
  }

  isLeader() { return this.leader; }

  private async acquire(): Promise<boolean> {
    const mine = this.me;
    const updated = await this.prisma.whatsappManager.updateMany({ where: { id: this.lockId, OR: [{ heartbeatAt: { lt: new Date(Date.now() - MANAGER_STALE_MS) } }, mine] }, data: { heartbeatAt: new Date(), ...mine } });
    if (updated.count === 1) return true;
    try { await this.prisma.whatsappManager.create({ data: { id: this.lockId, heartbeatAt: new Date(), ...mine } }); return true; } catch { return false; }
  }

  liveTenantIds() { return [...this.live.keys()]; }
  connectedTenantIds() { return [...this.live.entries()].filter(([, entry]) => entry.connected).map(([tenantId]) => tenantId); }

  async tick() {
    const leader = await this.acquire();
    if (!leader) {
      if (this.leader) { this.log('another manager took over: standing by'); for (const [tenantId, entry] of this.live) { this.live.delete(tenantId); await entry.transport.stop().catch(() => undefined); } }
      this.leader = false; return;
    }
    if (!this.leader) this.log('this process is now the WhatsApp session manager');
    this.leader = true;
    const rows = await this.prisma.whatsappSession.findMany(this.only ? { where: { tenantId: { in: this.only } } } : undefined);
    const denied = await this.unlicensed(rows.filter(row => row.desired === 'CONNECTED' || row.desired === 'RENEW').map(row => row.tenantId));
    for (const row of rows) {
      const entry = this.live.get(row.tenantId);
      if (denied.has(row.tenantId) && (row.desired === 'CONNECTED' || row.desired === 'RENEW')) {
        // Module revoked or license suspended by the administrator: the session is paused (pairing kept), and resumes when access returns.
        if (entry) { this.live.delete(row.tenantId); await entry.transport.stop().catch(() => undefined); }
        if (row.status !== 'DISCONNECTED' || !row.lastError) await this.setSession(row.tenantId, { status: 'DISCONNECTED', qr: null, lastError: 'O módulo WhatsApp não está liberado para esta empresa. Fale com o suporte.' });
        continue;
      }
      if (row.desired === 'LOGOUT') {
        if (entry) { this.live.delete(row.tenantId); await entry.transport.stop({ logout: true }).catch(() => undefined); }
        await wipeAllAuth(this.prisma, row.tenantId); this.failures.delete(row.tenantId); this.retryAt.delete(row.tenantId);
        await this.prisma.whatsappSession.update({ where: { tenantId: row.tenantId }, data: { desired: 'DISCONNECTED', status: 'LOGGED_OUT', qr: null, phone: null, pushName: null, connectedAt: null, lastError: null } });
      } else if (row.desired === 'RENEW') {
        // "Renovar": drop the socket, forget failed attempts and connect again (a fresh QR Code when the number is not paired).
        if (entry) { this.live.delete(row.tenantId); await entry.transport.stop().catch(() => undefined); }
        this.failures.delete(row.tenantId); this.retryAt.delete(row.tenantId);
        await this.prisma.whatsappSession.update({ where: { tenantId: row.tenantId }, data: { desired: 'CONNECTED', status: 'CONNECTING', qr: null, lastError: null } });
      } else if (row.desired === 'CONNECTED') {
        if (!entry && (this.retryAt.get(row.tenantId) ?? 0) <= Date.now()) {
          if (this.live.size >= MAX_SESSIONS()) { await this.setSession(row.tenantId, { status: 'CONNECTING', lastError: 'Capacidade de sessões do servidor atingida. Tente novamente em instantes.' }); continue; }
          await this.connect(row.tenantId);
        }
      } else if (entry) {
        this.live.delete(row.tenantId); await entry.transport.stop().catch(() => undefined);
        await this.prisma.whatsappSession.update({ where: { tenantId: row.tenantId }, data: { status: 'DISCONNECTED', qr: null } });
      }
    }
    await this.processOutbox();
  }

  // Tenants whose license/module does not allow the WhatsApp area right now (same rule the API gate applies to /api/v1/whatsapp).
  private async unlicensed(tenantIds: string[]): Promise<Set<string>> {
    const denied = new Set<string>();
    if (tenantIds.length === 0) return denied;
    const [tenants, blocked] = await Promise.all([
      this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, license: true, modules: { select: { moduleKey: true, blocked: true, startsAt: true, endsAt: true } } } }),
      globallyBlockedModules(async () => (await this.prisma.saaSModule.findMany({ where: { blocked: true }, select: { key: true } })).map(item => item.key)),
    ]);
    for (const tenant of tenants) if (licenseDenial(tenant.license, effectiveModules(tenant.modules, blocked), '/api/v1/whatsapp')) denied.add(tenant.id);
    return denied;
  }

  private async setSession(tenantId: string, data: Prisma.WhatsappSessionUpdateInput) {
    await this.prisma.whatsappSession.update({ where: { tenantId }, data }).catch(() => undefined);
  }

  private async connect(tenantId: string) {
    const transport = this.factory(tenantId);
    const entry: Live = { transport, connected: false, unconfirmedCloses: this.failures.get(tenantId) ?? 0, sentAt: [], chains: new Map(), storing: new Map() };
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
        onMessage: message => this.receive(tenantId, entry, message),
      });
    } catch (error) {
      this.live.delete(tenantId);
      await this.failConnection(tenantId, entry, error instanceof Error ? error.message : 'START_FAILED');
    }
  }

  private async failConnection(tenantId: string, entry: Live, reason: string) {
    const attempts = entry.unconfirmedCloses + 1;
    this.failures.set(tenantId, attempts);
    // After several QR cycles nobody scanned: stop instead of generating codes forever — unless someone is still looking at the screen, in which case the
    // code keeps being renewed. The pairing screen opening again reconnects by itself.
    const viewed = await this.prisma.whatsappSession.findUnique({ where: { tenantId }, select: { viewedAt: true } }).catch(() => null);
    const viewing = Boolean(viewed?.viewedAt && Date.now() - viewed.viewedAt.getTime() < VIEWER_ACTIVE_MS);
    if (!entry.connected && attempts >= MAX_UNCONFIRMED_CLOSES && !viewing) {
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
      await wipeAllAuth(this.prisma, tenantId); this.failures.delete(tenantId); this.retryAt.delete(tenantId);
      this.log(`tenant ${tenantId} logged out from the phone`);
      await this.setSession(tenantId, { desired: 'DISCONNECTED', status: 'LOGGED_OUT', qr: null, phone: null, pushName: null, connectedAt: null, lastError: 'A sessão foi encerrada pelo celular. Conecte novamente.' });
      return;
    }
    if (entry.connected) { this.failures.delete(tenantId); this.retryAt.set(tenantId, Date.now() + 2_000); await this.setSession(tenantId, { status: 'CONNECTING', lastError: info.error?.slice(0, 300) ?? null }); return; }
    await this.failConnection(tenantId, entry, info.error ?? 'CONNECTION_CLOSED');
  }

  // The AI attendant can take seconds per message: a few conversations run at once (the provider has its own rate limits), the rest wait their turn.
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, Number(process.env.WHATSAPP_PARALLEL_CHATS) || 4);
    // A waiter inherits the slot of whoever finishes, so the limit is never exceeded, not even for an instant.
    if (this.active >= limit) await new Promise<void>(resolve => this.waiters.push(resolve)); else this.active += 1;
    try { return await work(); } finally { const next = this.waiters.shift(); if (next) next(); else this.active -= 1; }
  }

  private async throttle(entry: Live) {
    const now = Date.now();
    entry.sentAt = entry.sentAt.filter(time => now - time < 60_000);
    if (entry.sentAt.length >= MAX_PER_MINUTE) await this.sleep(60_000 - (now - entry.sentAt[0]) + 50);
    entry.sentAt.push(Date.now());
  }

  // A customer's message is stored the moment it arrives (one at a time, in arrival order) and answered when its turn comes: one customer's messages are handled
  // strictly in order, so a reply may rely on the previous one, and a burst of messages sent in pieces is answered once, together. Different customers run in parallel.
  private receive(tenantId: string, entry: Live, message: InboundMessage) {
    if (message.timestamp && Date.now() / 1000 - message.timestamp > 120) return;
    const input: InboundInput = { tenantId, jid: message.jid, phone: message.phone, name: message.name, text: message.text, externalId: message.id };
    const previousStore = entry.storing.get(message.jid) ?? Promise.resolve();
    const stored: Promise<StoredInbound | null> = previousStore.then(() => storeInbound(this.prisma, input)).catch(error => { this.log(`could not store a message: ${error instanceof Error ? error.message : String(error)}`); return null; });
    const storeTail = stored.then(() => undefined);
    entry.storing.set(message.jid, storeTail);
    void storeTail.then(() => { if (entry.storing.get(message.jid) === storeTail) entry.storing.delete(message.jid); });
    const previous = entry.chains.get(message.jid) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(async () => { const saved = await stored; if (!saved) return; await this.settle(entry, message.jid); await this.withSlot(() => this.answer(tenantId, entry, input, saved, message.jid)); })
      .catch(error => this.log(`message error: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (entry.chains.get(message.jid) === next) entry.chains.delete(message.jid); });
    entry.chains.set(message.jid, next);
  }

  // People type in pieces ("quero reservar" ... "pra 4 pessoas"): wait a moment for the rest of the burst and for any piece still being stored, so the customer gets
  // one answer to everything they said. Outside the concurrency limit: waiting never holds a slot the AI attendant could use.
  private async settle(entry: Live, jid: string) {
    const wait = Math.max(0, Number(process.env.WHATSAPP_BATCH_WAIT_MS ?? 1000) || 0);
    if (wait > 0) await this.sleep(wait);
    await entry.storing.get(jid);
  }

  private async answer(tenantId: string, entry: Live, input: InboundInput, stored: StoredInbound, jid: string) {
    const outcome = await answerInbound(this.prisma, input, stored, new Date(), { batch: true });
    if (!outcome.conversationId || outcome.replies.length === 0) return;
    const settings = await loadSettings(this.prisma, tenantId);
    for (const reply of outcome.replies) {
      await this.throttle(entry);
      const typingMs = settings.whatsapp.humanizeTyping ? Math.min(4000, 600 + reply.length * 15) : 0;
      if (settings.whatsapp.replyDelaySeconds > 0) await this.sleep(settings.whatsapp.replyDelaySeconds * 1000);
      try {
        const id = await entry.transport.sendText(jid, reply, { typingMs });
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

// Mode: unset/'auto' (default) lets both the API and the worker run a manager with leader election, so QR sessions work whichever of them is deployed;
// 'api' or 'worker' restricts it to one process; 'off' disables QR sessions.
export type SessionsMode = 'api' | 'worker' | 'auto' | 'off';
export function whatsappSessionsMode(env: NodeJS.ProcessEnv = process.env): SessionsMode {
  const value = env.WHATSAPP_SESSIONS_MODE;
  return value === 'api' || value === 'worker' || value === 'off' ? value : 'auto';
}
export const runsInApi = (mode = whatsappSessionsMode()) => mode === 'api' || mode === 'auto';
export const runsInWorker = (mode = whatsappSessionsMode()) => mode === 'worker' || mode === 'auto';
