import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bell } from 'lucide-react';
import type { ReactNode } from 'react';

import { logout } from '@/app/actions';
import { MobileNav, type NavItem } from '@/components/mobile-nav';
import { NavLink } from '@/components/nav';
import { Logo } from '@/components/ui';
import { apiFetch, ApiError } from '@/lib/api';
import { readSession } from '@/lib/session';
import type { EntitlementsResponse, TenantResponse } from '@flightsquare/shared';

/**
 * Labels only. Every number beside them comes off the wire (§8.1) — this is
 * the same list the footer renders and the same keys the 402 body carries.
 */
const QUOTA_NOUNS: Record<string, string> = {
  'aircraft.active': 'aircraft',
  'members.active': 'member',
  'storage.bytes': 'storage',
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (!session) redirect('/login');
  if (!session.tenantId) redirect('/choose-tenant');

  let tenant: TenantResponse;
  let entitlements: EntitlementsResponse;
  try {
    [tenant, entitlements] = await Promise.all([
      apiFetch<TenantResponse>('/tenant'),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    // The session outlived the membership, the tenant was suspended, or the
    // token is gone. Those mean: sign in again.
    //
    // A plain `forbidden` does not, and treating it as one was how a Pilot
    // got locked out of the whole app: the shell read a 403 about a
    // permission they simply do not hold, sent them to the login screen,
    // and the login screen sent them straight back. §1.6 keeps 401 and 403
    // separate questions, and so does this.
    if (error instanceof ApiError) {
      const body = error.body as { error?: string } | null;
      if (error.status === 401 || body?.error === 'tenant_required') redirect('/login');
    }
    throw error;
  }

  /*
    The bell (§3.8). Its own request and its own failure: a feed that cannot be
    counted must not take the whole shell down with it, and no dot is the right
    answer when we do not know.
  */
  const unread = await apiFetch<{ unread: number }>('/notifications/unread-count')
    .then((body) => body.unread)
    .catch(() => 0);

  const aircraftQuota = entitlements.quotas['aircraft.active'];
  const memberQuota = entitlements.quotas['members.active'];

  /**
   * §5.2: over a limit, reads work normally and existing records keep
   * working — only creating more of that thing is refused. Which means the
   * condition is otherwise invisible until somebody walks into a 402, and
   * §5.3 wants the club to be told what is over and offered a way out.
   *
   * Computed rather than stored: it is the count §4.5 keeps against the
   * limit §1.4 resolves, and inventing a state column for something both
   * sides already know would be a third place to get it wrong.
   */
  const over = Object.entries(entitlements.quotas)
    .filter(([, quota]) => quota.limit !== 'unlimited' && (quota.current ?? 0) > quota.limit)
    .map(([key]) => QUOTA_NOUNS[key] ?? key);

  const canSeePlan = entitlements.permissions.subscription !== 'none';

  /**
   * Whether anybody shares these aeroplanes. Unknown counts as shared: §4.3
   * says scheduling is never *unavailable*, so the failure mode is offering
   * a calendar nobody needs rather than hiding one somebody does.
   */
  const pilots = entitlements.quotas['members.active']?.current;
  const sharesAircraft = pilots === undefined || pilots > 1;

  /*
   * The destinations, built once and rendered twice — a row above `md`, a
   * disclosure panel below it. One list because the conditions below are the
   * interesting part and having them in two places is how the two navs drift.
   *
   * Three shapes the product has: the fleet, what it owes, and what is wrong
   * with it. Squawks sit apart from maintenance for the same reason §1.5 keeps
   * them separate resources — filing a defect and signing off the work are
   * different acts done by different people.
   */
  const navItems: NavItem[] = [
    { href: '/aircraft', label: 'Fleet' },
    /*
      §4.3: scheduling is *unused* for a tenant with one pilot, never switched
      off. Nobody to share with means nothing to book around, so the calendar
      is not led with — and the moment a second member is invited it is back,
      with every booking still where it was. The route, the API and the
      policies are untouched; this is the nav not offering a destination, not a
      feature being gated.

      The pilot count and not the plan, because the constitution is emphatic
      that "scheduling need tracks pilot count, not ownership" — and because
      §1.3 forbids branching on the tenant, which a check against `plan_code`
      would be.
    */
    ...(sharesAircraft ? [{ href: '/schedule', label: 'Schedule' }] : []),
    /*
      The other half of §3.4's loop. Everyone holds `flights: write` (§4.4), so
      there is nothing to gate — a club's flights are shared on purpose,
      because who flew what is how the meters and the money reconcile.
    */
    { href: '/flights', label: 'Flights' },
    { href: '/maintenance', label: 'Maintenance' },
    { href: '/squawks', label: 'Squawks' },
    /*
      §8.1: fetched, never compiled in. Billing is Pro and up, so on a free
      tenant the API answers 404 and there is no reason to offer the
      destination — and a Pilot with `charges: none` has nothing there either.
      A nav full of destinations that answer 403 is worse than a shorter nav,
      and the server refuses either way.
    */
    ...(entitlements.flags.member_billing && entitlements.permissions.charges !== 'none'
      ? [{ href: '/billing', label: 'Billing' }]
      : []),
    ...(entitlements.permissions.members === 'none'
      ? []
      : [{ href: '/members', label: 'Members' }]),
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="relative mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6 md:gap-8">
          {/* §11 keeps the logo separate from the navigation icons, and uses
              the horizontal lockup in desktop headers. */}
          {/* Measured 89x30, under §13's 44px floor. The padding makes the
              target without moving the lockup, and the negative margin keeps
              it optically aligned with the content below. */}
          <Link href="/aircraft" className="-mx-2 flex h-11 shrink-0 items-center px-2">
            <Logo />
          </Link>

          {/*
            Three destinations, which is the shape of the product: the fleet,
            what it owes, and what is wrong with it. Squawks sit apart from
            maintenance for the same reason §1.5 keeps them separate
            resources — filing a defect and signing off the work are
            different acts done by different people.
          */}
          {/* The established row, unchanged, from `md` up. */}
          <nav className="hidden flex-1 items-center gap-6 md:flex">
            {navItems.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          {/* Below `md` the row is replaced, not squeezed: eight links with
              gap-6 measured 752px against a 390px viewport. */}
          <span className="flex-1 md:hidden" />

          {/*
            §11 §7: an outline icon in navy, with the count as a word for a
            screen reader rather than a dot alone — colour carries nothing on its
            own (§11 §13).
          */}
          <Link
            href="/notifications"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
            className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-subtle"
          >
            <Bell aria-hidden size={20} strokeWidth={1.75} />
            {unread > 0 ? (
              <span
                aria-hidden
                className="absolute right-2.5 top-2.5 size-2 rounded-full border-2 border-surface bg-navy"
              />
            ) : null}
          </Link>

          <span className="hidden text-sm text-secondary md:inline">{tenant.name}</span>
          {/* Above `md` it sits in the header as before. Below it, the header
              has no room for it and 54x20 was never a tap target, so it moves
              into the panel as a full-width row. */}
          <form action={logout} className="hidden md:block">
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-lg px-2 text-sm font-semibold hover:bg-subtle"
            >
              Sign out
            </button>
          </form>

          <MobileNav items={navItems}>
            <form action={logout}>
              <button
                type="submit"
                className="flex min-h-12 w-full items-center rounded-lg px-3 text-base font-medium text-secondary hover:bg-subtle hover:text-navy"
              >
                Sign out
              </button>
            </form>
          </MobileNav>
        </div>
      </header>

      {/*
        One line, above everything, for the two conditions a member cannot
        otherwise see. §11: the wording carries the meaning, and the border
        rather than a colour carries the weight.
      */}
      {tenant.status === 'past_due' || over.length > 0 ? (
        <div className="mx-auto max-w-4xl px-6 pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-navy bg-subtle px-5 py-3 text-sm">
            <p>
              {tenant.status === 'past_due'
                ? 'A payment to FlightSquare did not go through. Nothing has been switched off.'
                : `Over the ${over.join(' and ')} limit on this plan. Everything keeps working; you cannot add another.`}
            </p>
            {canSeePlan ? (
              <Link
                href="/settings/subscription"
                className="font-semibold underline decoration-1 underline-offset-4"
              >
                {tenant.status === 'past_due' ? 'Update the card' : 'See the options'}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>

      {/*
        §8.1: entitlements are fetched, never compiled in. This footer reads
        what the API resolved rather than a table of what each plan includes —
        that table would go stale and could not be corrected without a release.
      */}
      <footer className="mx-auto max-w-4xl px-6 pb-8 text-xs text-secondary">
        {entitlements.plan_code} plan · aircraft{' '}
        {aircraftQuota?.limit === 'unlimited' ? 'unlimited' : aircraftQuota?.limit} · members{' '}
        {memberQuota?.limit === 'unlimited' ? 'unlimited' : memberQuota?.limit}
      </footer>
    </div>
  );
}
