import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type { AircraftResponse } from '@flightsquare/shared';

import { LogFlightForm } from './form';

export default async function LogFlightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let aircraft: AircraftResponse;
  try {
    aircraft = await apiFetch<AircraftResponse>(`/aircraft/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/aircraft/${id}`}
          className="text-sm font-semibold text-teal-text underline underline-offset-2"
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
      <LogFlightForm aircraft={aircraft} />
    </div>
  );
}
