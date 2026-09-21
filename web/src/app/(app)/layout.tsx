import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { logout } from '@/app/actions';
import { NavLink } from '@/components/nav';
import { Logo } from '@/components/ui';
import { apiFetch, ApiError } from '@/lib/api';
import { readSession } from '@/lib/session';
import type { EntitlementsResponse, TenantResponse } from '@flightsquare/shared';

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
