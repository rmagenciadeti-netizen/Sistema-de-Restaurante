// Offline queue for the PDV: orders created without connection are kept on the device and sent later with the same idempotency key
// (`clientRequestId`), so a retry — or two tabs flushing at once — can never sell twice. Only orders are queued: payments, TEF and
// fiscal documents need the network and are done at the cashier after the sync.

export type QueuedOrder = { key: string; tenantId: string; body: Record<string, unknown>; label: string; createdAt: string; attempts: number; error?: string };
export interface QueueStore { put(entry: QueuedOrder): Promise<void>; all(): Promise<QueuedOrder[]>; remove(key: string): Promise<void> }
export type SendResult = { duplicate?: boolean } | void;
export type FlushSummary = { sent: number; duplicates: number; blocked: number; remaining: number; stopped: boolean };

const KEY_PATTERN = /^[\w-]{8,64}$/;
export const newRequestKey = () => `pos-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`)}`.slice(0, 64);

// Network failures (fetch rejects) and server-side/transient statuses stop the flush and are retried later; a definitive 4xx answer blocks that
// order for the operator to review instead of retrying forever.
export function classifyFailure(error: unknown): 'retry' | 'blocked' {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status !== 'number') return 'retry';
  return status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status) ? 'blocked' : 'retry';
}

export function createOfflineQueue(store: QueueStore, now: () => Date = () => new Date()) {
  return {
    async enqueue(input: { tenantId: string; body: Record<string, unknown>; label: string; key?: string }): Promise<QueuedOrder> {
      const key = input.key ?? newRequestKey();
      if (!KEY_PATTERN.test(key)) throw new Error('Invalid request key');
      const entry: QueuedOrder = { key, tenantId: input.tenantId, body: { ...input.body, clientRequestId: key }, label: input.label, createdAt: now().toISOString(), attempts: 0 };
      await store.put(entry);
      return entry;
    },
    async pending(tenantId?: string): Promise<QueuedOrder[]> {
      return (await store.all()).filter(entry => !tenantId || entry.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    // Sends in creation order. Entries of another restaurant (a different user signed in on the same device) are never sent.
    async flush(tenantId: string, send: (body: Record<string, unknown>) => Promise<SendResult>): Promise<FlushSummary> {
      const summary: FlushSummary = { sent: 0, duplicates: 0, blocked: 0, remaining: 0, stopped: false };
      for (const entry of await this.pending(tenantId)) {
        if (entry.error) { summary.blocked += 1; continue; }
        try {
          const result = await send(entry.body);
          await store.remove(entry.key);
          if (result && (result as { duplicate?: boolean }).duplicate) summary.duplicates += 1; else summary.sent += 1;
        } catch (error) {
          if (classifyFailure(error) === 'blocked') { await store.put({ ...entry, attempts: entry.attempts + 1, error: error instanceof Error ? error.message : 'Pedido recusado pelo servidor' }); summary.blocked += 1; }
          else { await store.put({ ...entry, attempts: entry.attempts + 1 }); summary.stopped = true; break; }
        }
      }
      summary.remaining = (await this.pending(tenantId)).length;
      return summary;
    },
    discard: (key: string) => store.remove(key),
    // After the operator fixed the cause (e.g. restored a product) a blocked order can be tried again.
    async retry(key: string) { const entry = (await store.all()).find(item => item.key === key); if (entry) await store.put({ ...entry, error: undefined }); },
  };
}

// IndexedDB implementation (browser only).
export function indexedDbStore(name = 'rm-pos-offline'): QueueStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('orders', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction('orders', mode).objectStore('orders'));
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  };
  return {
    put: entry => run('readwrite', store => store.put(entry)).then(() => undefined),
    all: () => run<QueuedOrder[]>('readonly', store => store.getAll()),
    remove: key => run('readwrite', store => store.delete(key)).then(() => undefined),
  };
}
