import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PlaneTakeoff } from 'lucide-react';
import type { ReactNode } from 'react';

import { ApiError, apiFetch } from '@/lib/api';
import { Button, PageTitle, Status } from '@/components/ui';
import type { AircraftResponse, EntitlementsResponse } from '@flightsquare/shared';

import { AircraftTabs } from './tabs';

/**
 * One aeroplane, across three tabs.
 *
 * This used to be a single page carrying the dispatch picture, the meter log,
 * the checkout list, the settings form and the archive button in one column.
 * Everything was true and none of it was findable: a pilot checking whether
 * they could take it scrolled past the rate configuration, and an admin
 * changing the billing meter scrolled past the squawks.
 *
 * The header and the tabs live in a layout so they survive navigation between
 * them, and in a `(tabs)` route group so that `log-flight` and `documents` —
 * which are children of this aeroplane but carry their own headers — do not
 * inherit a second one.
 */
export default async function AircraftTabsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let aircraft: AircraftResponse;
  let entitlements: EntitlementsResponse;
  try {
    [aircraft, entitlements] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  // §8.1: the client hides what this member cannot do, and the server enforces
  // it regardless. A Pilot holds `aircraft: read` — they see the aeroplane and
  // every number on it, and change none of them, so there is no Settings tab.
  const canWrite = entitlements.permissions.aircraft === 'write';
  const base = `/aircraft/${id}`;

  const tabs = [
    { href: base, label: 'Dashboard' },
    // A Pilot holds `maintenance.summary: read` (§4.4), which is what this tab
    // shows them; the item detail behind it is gated server-side.
    ...(entitlements.permissions['maintenance.summary'] === 'none'
      ? []
      : [{ href: `${base}/maintenance`, label: 'Maintenance' }]),
    ...(canWrite ? [{ href: `${base}/settings`, label: 'Settings' }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {/* Registrations stay uppercase: §11 reserves it for exactly this. */}
            <PageTitle>{aircraft.registration}</PageTitle>
            {aircraft.status !== 'active' ? (
              <Status kind="neutral">{aircraft.status}</Status>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-secondary">
            {[aircraft.type_code, aircraft.year_manufactured, aircraft.home_base]
              .filter(Boolean)
              .join(' · ') || 'No details yet'}
          </p>
        </div>
        {/*
          One dominant primary per section (§11), and on this screen it is
          logging a flight — §3.4 puts that above everything else, because a
          post-flight entry that does not get made is how every number in the
          product goes quietly wrong. In the header so it is on every tab.
        */}
        {aircraft.status === 'active' ? (
          <Link href={`${base}/log-flight`}>
            <Button>
              <PlaneTakeoff aria-hidden size={16} strokeWidth={2} />
              Log flight
            </Button>
          </Link>
        ) : null}
      </div>

      <AircraftTabs id={id} tabs={tabs} />

      {children}
    </div>
  );
}
