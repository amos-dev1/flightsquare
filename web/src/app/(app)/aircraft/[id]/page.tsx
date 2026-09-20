import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PlaneTakeoff } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Button, Card, KeyMetric, Meter, PageTitle, SectionHeading, Status } from '@/components/ui';
import type { AircraftResponse, MeterReadingResponse } from '@flightsquare/shared';

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
  try {
    [aircraft, readings] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<MeterReadingResponse[]>(`/aircraft/${id}/meter-readings`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

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
        <div className="flex items-center gap-3">
          {aircraft.status === 'active' ? (
            <Link href={`/aircraft/${aircraft.id}/log-flight`}>
              <Button>
                <PlaneTakeoff aria-hidden size={16} strokeWidth={2} />
                Log flight
              </Button>
            </Link>
          ) : null}
          <ArchiveButton
            id={aircraft.id}
            registration={aircraft.registration}
            status={aircraft.status}
          />
        </div>
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

      <section className="space-y-3">
        <SectionHeading>Record a reading</SectionHeading>
        <ReadingForm aircraftId={aircraft.id} />
      </section>

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
    </div>
  );
}
