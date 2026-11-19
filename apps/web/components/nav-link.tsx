'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { forwardRef, type ComponentProps } from 'react';

// Drop-in replacement for next/link that prefetches a screen only when the user shows intent (hover, keyboard focus, touch) instead of every link that scrolls into view.
// A side menu with dozens of links otherwise downloads a dozen screens in the background on every page; here it downloads the one that is about to be opened. Save-Data connections never prefetch.
const warmed = new Set<string>();

const NavLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(function NavLink({ href, prefetch, onMouseEnter, onFocus, onTouchStart, ...props }, ref) {
  const router = useRouter();
  const warm = () => {
    const target = typeof href === 'string' ? href : href.pathname ?? '';
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (saveData || !target.startsWith('/') || warmed.has(target)) return;
    warmed.add(target);
    router.prefetch(target);
  };
  return <Link ref={ref} href={href} prefetch={prefetch ?? false}
    onMouseEnter={event => { warm(); onMouseEnter?.(event); }} onFocus={event => { warm(); onFocus?.(event); }} onTouchStart={event => { warm(); onTouchStart?.(event); }} {...props} />;
});
export default NavLink;
