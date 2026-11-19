'use client';

import { api, userStorageKey } from './api';
import { classifyFailure, createOfflineQueue, indexedDbStore, newRequestKey, type FlushSummary, type QueuedOrder } from './offline-queue';

// Browser glue of the PDV offline mode (queue lives in IndexedDB; see offline-queue.ts for the rules).
let queue: ReturnType<typeof createOfflineQueue> | null = null;
const getQueue = () => (queue ??= createOfflineQueue(indexedDbStore()));
const listeners = new Set<() => void>();
export const subscribeQueue = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach(listener => listener());

export function currentTenantId(): string | null {
  try { return (JSON.parse(localStorage.getItem(userStorageKey) ?? 'null') as { tenantId?: string | null } | null)?.tenantId ?? null; } catch { return null; }
}

export class OrderQueuedOffline extends Error {
  constructor(readonly entry: QueuedOrder) { super('Order saved on this device'); }
}

// Creates the order online, or keeps it on the device when there is no connection. The same key goes with every attempt, so if a request
// reached the server but its answer was lost, the later sync returns that order instead of creating a second one.
export async function placeOrder<T>(body: Record<string, unknown>, label: string): Promise<T> {
  const tenantId = currentTenantId();
  const key = newRequestKey();
  const payload = { ...body, clientRequestId: key };
  const keep = async () => { if (!tenantId) throw new Error('Sessão sem restaurante: não é possível guardar o pedido offline.'); const entry = await getQueue().enqueue({ tenantId, body, label, key }); notify(); throw new OrderQueuedOffline(entry); };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return keep();
  try { return await api<T>('/orders', { method: 'POST', body: JSON.stringify(payload) }); }
  catch (error) {
    // Only a missing answer (network failure) is queued; any answer from the server, even an error, is shown to the operator right away.
    if (typeof (error as { status?: number }).status !== 'number' && classifyFailure(error) === 'retry') return keep();
    throw error;
  }
}

export async function pendingOrders(): Promise<QueuedOrder[]> {
  const tenantId = currentTenantId();
  return tenantId ? getQueue().pending(tenantId) : [];
}

let syncing = false;
export async function syncOrders(): Promise<FlushSummary | null> {
  const tenantId = currentTenantId();
  if (!tenantId || syncing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return null;
  syncing = true;
  try { return await getQueue().flush(tenantId, body => api<{ duplicate?: boolean }>('/orders', { method: 'POST', body: JSON.stringify(body) })); }
  finally { syncing = false; notify(); }
}
export const retryOrder = async (key: string) => { await getQueue().retry(key); notify(); };
export const discardOrder = async (key: string) => { await getQueue().discard(key); notify(); };

// A request that never got an answer (offline, DNS, timeout) — as opposed to an HTTP error answered by the server.
export const isNetworkFailure = (error: unknown) => typeof (error as { status?: number } | null)?.status !== 'number';

// Last successful PDV load, per restaurant, kept in its own IndexedDB store (a catalog can be larger than what localStorage allows).
const SNAPSHOT_DB = 'rm-pos-snapshots';
const openSnapshots = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(SNAPSHOT_DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const snapshotKey = (name: string) => `${currentTenantId() ?? 'anonymous'}:${name}`;
export async function saveSnapshot(name: string, value: unknown): Promise<void> {
  try {
    const db = await openSnapshots();
    await new Promise<void>((resolve, reject) => { const request = db.transaction('snapshots', 'readwrite').objectStore('snapshots').put({ value, savedAt: new Date().toISOString() }, snapshotKey(name)); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    db.close();
  } catch { /* storage unavailable: the PDV simply will not work offline */ }
}
export async function loadSnapshot<T>(name: string): Promise<T | null> {
  try {
    const db = await openSnapshots();
    const stored = await new Promise<{ value: T } | undefined>((resolve, reject) => { const request = db.transaction('snapshots').objectStore('snapshots').get(snapshotKey(name)); request.onsuccess = () => resolve(request.result as { value: T } | undefined); request.onerror = () => reject(request.error); });
    db.close();
    return stored?.value ?? null;
  } catch { return null; }
}
