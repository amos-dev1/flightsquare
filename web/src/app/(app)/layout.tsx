import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { logout } from '@/app/actions';
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

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-8 px-6">
          {/* §11 keeps the logo separate from the navigation icons, and uses
              the horizontal lockup in desktop headers. */}
          <Link href="/aircraft" className="-ml-2 shrink-0">
            <Logo />
          </Link>

          {/*
            Three destinations, which is the shape of the product: the fleet,
            what it owes, and what is wrong with it. Squawks sit apart from
            maintenance for the same reason §1.5 keeps them separate
            resources — filing a defect and signing off the work are
            different acts done by different people.
          */}
          <nav className="flex flex-1 items-center gap-6">
            <NavLink href="/aircraft">Fleet</NavLink>
            <NavLink href="/schedule">Schedule</NavLink>
            <NavLink href="/maintenance">Maintenance</NavLink>
            <NavLink href="/squawks">Squawks</NavLink>
            {/*
              §8.1: hidden for a Pilot because they cannot use them, and the
              server refuses either way. A nav full of destinations that
              answer 403 is worse than a shorter nav.
            */}
            {/*
              §8.1: fetched, never compiled in. Billing is Pro and up, so on
              a free tenant the API answers 404 and there is no reason to
              offer the destination — and a Pilot with `charges: none` has
              nothing there either.
            */}
            {entitlements.flags.member_billing &&
            entitlements.permissions.charges !== 'none' ? (
              <NavLink href="/billing">Billing</NavLink>
            ) : null}
            {entitlements.permissions.members === 'none' ? null : (
              <NavLink href="/members">Members</NavLink>
            )}
            <NavLink href="/settings">Settings</NavLink>
          </nav>

          <span className="hidden text-sm text-secondary sm:inline">{tenant.name}</span>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg px-2 py-1 text-sm font-semibold hover:bg-subtle"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/*
        One line, above everything, for the two conditions a member cannot
        otherwise see. §11: the wording carries the meaning, and the border
        rather than a colour carries the weight.
      */}
      {tenant.status === 'past_due' || over.length > 0 ? (
        <div className="mx-auto max-w-4xl px-6 pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-brand-black bg-subtle px-5 py-3 text-sm">
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
