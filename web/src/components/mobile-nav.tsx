'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

export interface NavItem {
  href: string;
  label: string;
}

/**
 * The same destinations, on a phone.
 *
 * The header's nav is a single row of up to eight links with `gap-6`, which at
 * 390px measured 752px wide and forced every authenticated screen to scroll
 * sideways by about 516px. Nothing was hidden; the whole app was simply wider
 * than the device.
 *
 * A disclosure rather than a horizontally scrolling strip, because §11 §7 asks
 * to preserve the established navigation and a scrolling strip quietly loses
 * the items past the edge. The desktop row is untouched above `md`; this exists
 * below it. Hiding the panel's own content from the accessibility tree while
 * closed is `hidden`'s job, so there is no second copy of the nav for a screen
 * reader to walk.
 *
 * Rows are `min-h-12` (48px), past §13's 44px floor, because this is the
 * control someone uses one-handed on a ramp.
 */
export function MobileNav({ items, children }: { items: NavItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Navigating closes it. Without this the panel stays open over the page it
  // just moved to, which reads as the tap not having worked.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? 'Close menu' : 'Menu'}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-subtle md:hidden"
      >
        {open ? (
          <X aria-hidden size={20} strokeWidth={1.75} />
        ) : (
          <Menu aria-hidden size={20} strokeWidth={1.75} />
        )}
      </button>

      {/*
        Outside the header's flex row and full width, so a long list never
        competes with the logo for space. `md:hidden` on the panel as well as
        the button: resizing a desktop window down and back must not leave an
        orphaned open panel.
      */}
      <div
        id="mobile-nav"
        hidden={!open}
        className="absolute inset-x-0 top-16 z-40 border-b border-line bg-surface shadow-sm md:hidden"
      >
        <nav className="mx-auto flex max-w-4xl flex-col px-4 py-2">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-12 items-center rounded-lg px-3 text-base ${
                  active
                    ? 'bg-selected font-semibold text-navy'
                    : 'font-medium text-secondary hover:bg-subtle hover:text-navy'
                }`}
              >
                {/* §11 §7 asks for a cue beyond colour; the weight and the
                    teal marker do it, and aria-current says it outright. */}
                {item.label}
                {active ? (
                  <span aria-hidden className="ml-auto size-1.5 rounded-full bg-teal" />
                ) : null}
              </Link>
            );
          })}
          {children ? <div className="mt-1 border-t border-line pt-1">{children}</div> : null}
        </nav>
      </div>
    </>
  );
}
