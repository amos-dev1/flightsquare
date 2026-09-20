import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { logout } from '@/app/actions';
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
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-6">
          <Link href="/aircraft" className="text-sm font-semibold tracking-tight">
            FlightSquare
          </Link>
          <nav className="flex-1">
            <Link href="/aircraft" className="text-sm text-muted hover:text-ink">
              Fleet
            </Link>
          </nav>
          <span className="hidden text-sm text-muted sm:inline">{tenant.name}</span>
          <form action={logout}>
            <button type="submit" className="text-sm text-muted hover:text-ink">
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
      <footer className="mx-auto max-w-4xl px-6 pb-8 text-xs text-muted">
        {entitlements.plan_code} plan · aircraft{' '}
        {aircraftQuota?.limit === 'unlimited' ? 'unlimited' : aircraftQuota?.limit}
      </footer>
    </div>
  );
}
