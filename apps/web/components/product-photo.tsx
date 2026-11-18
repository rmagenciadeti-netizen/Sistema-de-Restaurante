'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const cache = new Map<string, string>();

// Loads a product photo only when its card scrolls into view; products without a photo render nothing.
export function ProductPhoto({ productId, version, name }: { productId: string; version?: string | null; name: string }) {
  const key = `${productId}:${version ?? ''}`;
  const holder = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(cache.get(key) ?? null);

  useEffect(() => {
    if (!version || cache.has(key) || !holder.current) return;
    const node = holder.current;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      api<{ dataUrl: string }>(`/products/${productId}/image`).then(result => { cache.set(key, result.dataUrl); if (active) setSrc(result.dataUrl); }).catch(() => undefined);
    });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [key, productId, version]);

  if (!version) return null;
  return <span ref={holder} className="-mx-3 -mt-3 mb-2 block h-24 overflow-hidden bg-slate-100">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {src && <img src={src} alt={name} loading="lazy" className="h-full w-full object-cover" />}
  </span>;
}
