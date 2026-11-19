'use client';

import { useEffect, useRef } from 'react';

// Runs `load` once on mount and, optionally, every `intervalMs`. Always calls the latest closure; state updates happen inside the async callback.
export function useAutoLoad(load: () => Promise<void> | void, intervalMs?: number) {
  const latest = useRef(load);
  useEffect(() => { latest.current = load; });
  useEffect(() => {
    void latest.current();
    if (!intervalMs) return undefined;
    // A hidden tab does not poll (no data spent on a screen nobody is looking at); when it becomes visible again after a missed tick it refreshes once.
    let missed = false;
    const id = setInterval(() => { if (typeof document !== 'undefined' && document.hidden) { missed = true; return; } void latest.current(); }, intervalMs);
    const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden && missed) { missed = false; void latest.current(); } };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible); };
  }, [intervalMs]);
}
