import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type { AircraftResponse, EntitlementsResponse } from '@flightsquare/shared';

import { MaintenanceItemForm } from '../item-form';

/**
 * Adding something to track.
 *
 * Nothing is instantiated behind anybody's back: the decision taken for Phase 1
 * was empty by default, because an aeroplane arriving with fifteen red items
 * nobody approved is the app asserting obligations it cannot know apply. This
 * form is how an item comes to exist, and the preset library is offered from the
 * empty state rather than applied on arrival.
 */
export default async function NewMaintenanceItemPage({
  searchParams,
}: {
  searchParams: Promise<{ aircraft?: string }>;
}) {
  const { aircraft: aircraftId } = await searchParams;
  if (!aircraftId) redirect('/maintenance');

  let aircraft: AircraftResponse;
  let entitlements: EntitlementsResponse;
  try {
    [aircraft, entitlements] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${aircraftId}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  // §8.1: the client hides what a member cannot do, and the server refuses it
  // regardless. A pilot reaching this URL gets the 404 the gate already gives.
  if (entitlements.permissions['maintenance.items'] !== 'write') notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/maintenance"
          className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Maintenance
        </Link>
        <PageTitle>New tracked item</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          For {aircraft.registration}. It counts down against the meters your flights already
          record.
        </p>
      </div>

      <MaintenanceItemForm aircraftId={aircraft.id} registration={aircraft.registration} />
    </div>
  );
}
