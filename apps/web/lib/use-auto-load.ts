'use client';

import { useEffect, useRef } from 'react';

// Runs `load` once on mount and, optionally, every `intervalMs`. Always calls the latest closure; state updates happen inside the async callback.
export function useAutoLoad(load: () => Promise<void> | void, intervalMs?: number) {
  const latest = useRef(load);
  useEffect(() => { latest.current = load; });
  useEffect(() => {
    void latest.current();
    if (!intervalMs) return undefined;
    const id = setInterval(() => void latest.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
