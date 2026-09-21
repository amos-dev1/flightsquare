import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PlaneTakeoff } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Button, Card, KeyMetric, Meter, PageTitle, SectionHeading, Status } from '@/components/ui';
import { AvailabilityLine, DueStatus, remainingLabel } from '@/app/(app)/maintenance/shared';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
  AuthorizationResponse,
  MemberResponse,
  MeterReadingResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { ArchiveButton, ReadingForm } from './client';
import { AircraftSettingsForm } from './settings-form';
import { Authorizations } from './authorizations';

export default async function AircraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ logged?: string }>;
}) {
  const { id } = await params;
  const { logged } = await searchParams;

  let aircraft: AircraftResponse;
  let readings: MeterReadingResponse[];
  let availability: AircraftAvailabilityResponse;
  let items: MaintenanceItemResponse[];
  let entitlements: EntitlementsResponse;
  let squawks: SquawkResponse[];
  let authorizations: AuthorizationResponse[];
  let members: MemberResponse[];
  try {
    [aircraft, readings, availability, items, entitlements, squawks, authorizations, members] =
      await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<MeterReadingResponse[]>(`/aircraft/${id}/meter-readings`),
      apiFetch<AircraftAvailabilityResponse>(`/aircraft/${id}/availability`),
      apiFetch<MaintenanceItemResponse[]>(`/aircraft/${id}/maintenance-items`),
      apiFetch<EntitlementsResponse>('/entitlements'),
      // V1_SCOPE M5: open squawks are visible to every member here, because
      // the next pilot needs to know what the last one found.
      apiFetch<SquawkResponse[]>(`/squawks?aircraft_id=${id}&open=true`),
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

  // §8.1: the client hides what this member cannot do, and the server
  // enforces it regardless. A Pilot holds `aircraft: read` — they see the
  // aeroplane and every number on it, and change none of them. Showing them
  // an Archive button that can only ever fail is worse than showing nothing.
  const canWrite = entitlements.permissions.aircraft === 'write';

  // Overdue first, then due soon. An item nobody has recorded compliance for
  // is on the list too: "we have no record" is not "it is fine".
  const attention = items
    .filter((item) => item.status === 'active')
    .filter((item) => item.state === 'overdue' || item.state === 'due_soon' || !item.ever_complied)
    .sort((a, b) => (a.state === 'overdue' ? 0 : 1) - (b.state === 'overdue' ? 0 : 1));

  return (
    <div className="space-y-6">
      {/* §11: a success state, stated near where the work happened. */}
      {logged ? (
        <Alert tone="info">
          Flight saved. The meters below now show the readings you entered.
        </Alert>
      ) : null}

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
          product goes quietly wrong.
        */}
        {aircraft.status === 'active' ? (
          <Link href={`/aircraft/${aircraft.id}/log-flight`}>
            <Button>
              <PlaneTakeoff aria-hidden size={16} strokeWidth={2} />
              Log flight
            </Button>
          </Link>
        ) : null}
      </div>

      {/*
        §11: Hobbs and tach are distinguished explicitly rather than left to
        column position, and the unit travels with the number.
      */}
      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <KeyMetric label="Hobbs" value={aircraft.hobbs} unit="hrs" />
        <KeyMetric label="Tach" value={aircraft.tach} unit="hrs" />
        <KeyMetric label="Airframe" value={aircraft.airframe_hours} unit="hrs" />
        {/*
          §3.4: fuel remaining is aircraft *state* — what the next pilot is
          walking out to — and never a running total computed across flights.
          It is the last figure somebody wrote down, shown as that.
        */}
        <KeyMetric
          label="Fuel remaining"
          value={aircraft.fuel_remaining}
          unit={aircraft.fuel_units === 'litres' ? 'L' : 'gal'}
        />
      </Card>

      {/*
        Dispatch state before anything else on the page, because it is the
        question the person opening this screen is actually asking. It is the
        same view the scheduler will consult (§3.3), so the answer here and
        the answer a booking gets cannot disagree.

        §11: never infer "Airworthy" from the absence of a warning. This says
        "available", which is a claim about this product's records, and it
        lists what it is relying on.
      */}
      <section className="space-y-3">
        <SectionHeading>Airworthiness</SectionHeading>
        <Card className="space-y-4 p-5">
          <AvailabilityLine row={availability} />

          {attention.length === 0 ? (
            <p className="text-sm text-secondary">
              {items.length === 0
                ? 'No maintenance intervals are being tracked.'
                : 'Nothing due in the near term.'}
            </p>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {attention.map((item) => (
                <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                  <span className="text-sm font-semibold">{item.name}</span>
                  <span className="flex items-center gap-3 text-sm text-secondary">
                    <span className="tabular">{remainingLabel(item)}</span>
                    <DueStatus item={item} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          <Link
            href="/maintenance"
            className="inline-block text-sm font-semibold underline decoration-1 underline-offset-4"
          >
            Record compliance
          </Link>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeading>Open squawks</SectionHeading>
        {squawks.length === 0 ? (
          <Card className="px-5 py-4 text-sm text-secondary">
            {/* Not "airworthy": §11 forbids reading that out of the absence
                of a warning, and nothing here has inspected anything. */}
            Nothing reported.
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {squawks.map((squawk) => (
              <div key={squawk.id} className="flex flex-wrap items-baseline gap-x-3 px-5 py-3">
                <span className="text-sm font-semibold">{squawk.summary}</span>
                {squawk.grounding && squawk.status === 'open' ? (
                  <Status kind="grounded" />
                ) : null}
                {squawk.status === 'deferred' ? <Status kind="neutral">Deferred</Status> : null}
                <span className="text-sm text-secondary">
                  {squawk.reported_by_email ?? 'a member'} ·{' '}
                  <time dateTime={squawk.reported_at}>
                    {new Date(squawk.reported_at).toLocaleDateString()}
                  </time>
                </span>
              </div>
            ))}
          </Card>
        )}
        <Link
          href="/squawks"
          className="inline-block text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Report a defect
        </Link>
      </section>

      {canWrite ? (
        <section className="space-y-3">
          <SectionHeading>Record a reading</SectionHeading>
          <ReadingForm aircraftId={aircraft.id} />
        </section>
      ) : null}

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
          <SectionHeading>Settings</SectionHeading>
          <AircraftSettingsForm aircraft={aircraft} />
        </section>
      ) : null}

      {canWrite ? (
        <section className="space-y-3">
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
