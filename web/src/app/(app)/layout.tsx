import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { logout } from '@/app/actions';
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
    // token is gone. All of them mean: sign in again.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      redirect('/login');
    }
    throw error;
  }

  const aircraftQuota = entitlements.quotas['aircraft.active'];

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-8 px-6">
          {/* §11 keeps the logo separate from the navigation icons, and uses
              the horizontal lockup in desktop headers. */}
          <Link href="/aircraft" className="-ml-2 shrink-0">
            <Logo />
          </Link>

          <nav className="flex-1">
            {/* Active item: black, heavier, and a small teal marker — the
                weight carries it when colour is unavailable. */}
            <Link
              href="/aircraft"
              aria-current="page"
              className="relative inline-flex h-16 items-center text-sm font-semibold text-brand-black"
            >
              Fleet
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent"
              />
            </Link>
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
        {aircraftQuota?.limit === 'unlimited' ? 'unlimited' : aircraftQuota?.limit}
      </footer>
    </div>
  );
}
