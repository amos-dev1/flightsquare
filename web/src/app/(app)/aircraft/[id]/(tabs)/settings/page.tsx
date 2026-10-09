import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, Meter, SectionHeading, Status } from '@/components/ui';
import type {
  AircraftResponse,
  AuthorizationResponse,
  EntitlementsResponse,
  MemberResponse,
  MeterReadingResponse,
} from '@flightsquare/shared';

import { ArchiveButton, ReadingForm } from '../../client';
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
  let readings: MeterReadingResponse[];
  try {
    [aircraft, entitlements, authorizations, members, readings] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
      // §3.5: who may fly this one. A club question, not a pilot record.
      apiFetch<AuthorizationResponse[]>(`/aircraft/${id}/authorizations`),
      // Only an admin can sign somebody off, and only they can read the
      // roster — so a Pilot gets an empty list and the form stays hidden.
      apiFetch<MemberResponse[]>('/members').catch(() => [] as MemberResponse[]),
      apiFetch<MeterReadingResponse[]>(`/aircraft/${id}/meter-readings`),
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

      {canWrite ? (
        <section className="space-y-3">
          <SectionHeading>Record a meter reading</SectionHeading>
          <p className="text-sm text-secondary">
            Flights move the meters on their own — log one instead of using this. This is for
            the opening figures when an aeroplane arrives, for a correction when somebody
            mistyped a number, and for hours that no flight accounts for, like a maintenance
            run or a new Hobbs.
          </p>
          {/*
            Deliberately not on the dashboard. §3.4's loop runs flight → meters
            → maintenance → charge, and a reading recorded instead of a flight
            advances the meters while leaving no `flight_charges` row and no
            `flown_by` — the member is not billed and nothing says who had the
            aeroplane. Keeping it here, behind `aircraft: write`, makes it the
            exception it is rather than a quicker-looking alternative sitting
            beside the meters it would corrupt.

            Readings are append-only (§3.4): a correction is a new row
            superseding the old one, and the log on the dashboard keeps both.
          */}
          <ReadingForm aircraftId={aircraft.id} />
        </section>
      ) : null}

      {/*
        The history behind the form above. Every flight writes a row here too,
        so this is the whole trail the maintenance numbers rest on rather than
        a list of manual entries.

        Readable by anyone holding `aircraft: read`, so it is not gated here —
        but the Settings tab itself is only offered to a member who can write,
        so in practice a Pilot will not come across it. The current figures
        they need before a flight are on the dashboard.
      */}
      <section className="space-y-3">
        <SectionHeading>Meter log</SectionHeading>
        {readings.length === 0 ? (
          <p className="text-sm text-secondary">Nothing recorded yet.</p>
        ) : (
          <Card className="divide-y divide-line">
            {readings.map((reading) => (
              <div key={reading.id} className="flex items-baseline gap-4 px-4 py-3 text-sm">
                <time className="w-40 shrink-0 text-secondary" dateTime={reading.recorded_at}>
                  {new Date(reading.recorded_at).toLocaleString()}
                </time>
                <div className="flex flex-1 flex-wrap gap-x-6 gap-y-1">
                  {reading.hobbs ? <span>Hobbs <Meter value={reading.hobbs} /></span> : null}
                  {reading.tach ? <span>Tach <Meter value={reading.tach} /></span> : null}
                  {reading.airframe_hours ? (
                    <span>Airframe <Meter value={reading.airframe_hours} /></span>
                  ) : null}
                  {reading.note ? <span className="text-secondary">{reading.note}</span> : null}
                </div>
                {/*
                  A superseded reading stays in the log and is labelled rather
                  than hidden: the correction and what it corrected are both
                  part of the trail the maintenance numbers rest on (§3.4).
                */}
                {reading.superseded ? <Status kind="neutral">Corrected</Status> : null}
              </div>
            ))}
          </Card>
        )}
      </section>

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
