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
  MeterReadingResponse,
} from '@flightsquare/shared';

import { ArchiveButton, ReadingForm } from './client';

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
  try {
    [aircraft, readings, availability, items, entitlements] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<MeterReadingResponse[]>(`/aircraft/${id}/meter-readings`),
      apiFetch<AircraftAvailabilityResponse>(`/aircraft/${id}/availability`),
      apiFetch<MaintenanceItemResponse[]>(`/aircraft/${id}/maintenance-items`),
      apiFetch<EntitlementsResponse>('/entitlements'),
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
        <div className="bg-surface px-5 py-4">
          <p className="text-xs font-medium text-secondary">Maintenance meter</p>
          <p className="mt-1 text-base font-semibold">{aircraft.maintenance_meter}</p>
        </div>
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
