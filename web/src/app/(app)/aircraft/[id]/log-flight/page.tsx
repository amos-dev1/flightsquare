import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type { AircraftResponse, EntitlementsResponse } from '@flightsquare/shared';

import { LogFlightForm } from './form';

export default async function LogFlightPage({ params }: { params: Promise<{ id: string }> }) {
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

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/aircraft/${id}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-text underline underline-offset-2"
        >
          {aircraft.registration}
        </Link>
        <div className="mt-1">
          <PageTitle>Log flight</PageTitle>
        </div>
      </div>

      {/*
        The readings the aircraft is currently showing are passed in so the
        form can prefill the "out" values. §3.4: if this takes more than a
        minute it does not get done, and the out values are the half the
        pilot should not have to type.
      */}
      {/*
        Filing a defect from here needs `squawks: write`, which both bundles in
        §4.4 hold — so in practice the section is always there. Asking anyway,
        because §8.1 makes hiding cosmetics and a future read-only bundle
        should not be shown a form the API will refuse.
      */}
      <LogFlightForm
        aircraft={aircraft}
        canSquawk={entitlements.permissions.squawks === 'write'}
      />
    </div>
  );
}
