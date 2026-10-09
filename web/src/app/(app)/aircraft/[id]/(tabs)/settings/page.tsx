import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { SectionHeading } from '@/components/ui';
import type {
  AircraftResponse,
  AuthorizationResponse,
  EntitlementsResponse,
  MemberResponse,
} from '@flightsquare/shared';

import { ArchiveButton } from '../../client';
import { AircraftSettingsForm } from '../../settings-form';
import { Authorizations } from '../../authorizations';

/**
 * How this aeroplane is configured — rates, meters, who may fly it.
 *
 * Separated from the dashboard because the audiences are different and the
 * frequencies are too: a pilot reads the dashboard before every flight and an
 * admin changes a rate twice a year. Mixing them put the billing meter between
 * the squawks and the meter log.
 *
 * The tab is only offered to a member holding `aircraft: write` (the layout
 * decides), and the API refuses regardless — §8.1: hiding is cosmetics.
 */
export default async function AircraftSettingsTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let aircraft: AircraftResponse;
  let entitlements: EntitlementsResponse;
  let authorizations: AuthorizationResponse[];
  let members: MemberResponse[];
  try {
    [aircraft, entitlements, authorizations, members] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
      // §3.5: who may fly this one. A club question, not a pilot record.
      apiFetch<AuthorizationResponse[]>(`/aircraft/${id}/authorizations`),
      // Only an admin can sign somebody off, and only they can read the
      // roster — so a Pilot gets an empty list and the form stays hidden.
      apiFetch<MemberResponse[]>('/members').catch(() => [] as MemberResponse[]),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const canWrite = entitlements.permissions.aircraft === 'write';

  return (
    <div className="space-y-6">
      {canWrite ? (
        <section className="space-y-3">
          <SectionHeading>Details</SectionHeading>
          <AircraftSettingsForm aircraft={aircraft} />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading>Who may fly it</SectionHeading>
        <Authorizations
          aircraftId={aircraft.id}
          registration={aircraft.registration}
          authorizations={authorizations}
          members={members}
          canWrite={entitlements.permissions.qualifications === 'write'}
        />
      </section>

      {canWrite ? (
        <section className="space-y-3">
          {/*
            §5.5: archiving is reversible and keeps the whole history — the
            aeroplane stops being bookable, it does not stop having existed.
          */}
          <ArchiveButton
            id={aircraft.id}
            registration={aircraft.registration}
            status={aircraft.status}
          />
        </section>
      ) : null}
    </div>
  );
}
