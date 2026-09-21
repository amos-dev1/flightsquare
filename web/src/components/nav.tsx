'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * §11: the active item is black, heavier, and carries a small teal marker.
 * The weight and the underline do the work where colour cannot — the marker
 * is emphasis, never the only signal, and `aria-current` says it outright.
 */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`relative inline-flex h-16 items-center text-sm transition-colors duration-150 ${
        active ? 'font-semibold text-brand-black' : 'font-medium text-secondary hover:text-brand-black'
      }`}
    >
      {children}
      {active ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent" />
      ) : null}
    </Link>
  );
}
