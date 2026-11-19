'use client';

import { useEffect } from 'react';

// Registers the service worker (application shell for offline use). Skipped in development so hot reload is never served from a cache.
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
