'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The three views of one aeroplane.
 *
 * Real routes rather than client-side panels, so each tab is a URL somebody
 * can send, the back button does what it looks like it does, and a member
 * without `aircraft: write` simply has no Settings tab rather than a tab that
 * refuses them.
 *
 * §11 §7's selected treatment, borrowed from the main nav for consistency:
 * weight, a teal marker and `aria-current`, never colour on its own.
 */
export function AircraftTabs({ id, tabs }: { id: string; tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const base = `/aircraft/${id}`;

  return (
    <div className="border-b border-line">
      <nav className="-mb-px flex gap-6 overflow-x-auto" aria-label="Aircraft">
        {tabs.map((tab) => {
          // The dashboard is the base path, so it must match exactly or every
          // tab would look active while on Maintenance.
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`relative inline-flex min-h-11 shrink-0 items-center border-b-2 px-1 text-sm transition-colors duration-150 ${
                active
                  ? 'border-teal font-semibold text-navy'
                  : 'border-transparent font-medium text-secondary hover:text-navy'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
