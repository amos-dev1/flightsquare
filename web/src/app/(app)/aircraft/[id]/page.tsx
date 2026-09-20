import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, Meter } from '@/components/ui';
import type { AircraftResponse, MeterReadingResponse } from '@flightsquare/shared';

import { ArchiveButton, ReadingForm } from './client';

export default async function AircraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {aircraft.registration}
            {aircraft.status !== 'active' ? (
              <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs font-normal text-muted">
                {aircraft.status}
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-muted">
            {[aircraft.type_code, aircraft.year_manufactured, aircraft.home_base]
              .filter(Boolean)
              .join(' · ') || 'No details yet'}
          </p>
        </div>
        <ArchiveButton id={aircraft.id} status={aircraft.status} />
      </div>

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <Total label="Hobbs" value={aircraft.hobbs} />
        <Total label="Tach" value={aircraft.tach} />
        <Total label="Airframe" value={aircraft.airframe_hours} />
        <Total
          label="Maintenance meter"
          value={null}
          text={aircraft.maintenance_meter}
        />
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Record a reading</h2>
        <ReadingForm aircraftId={aircraft.id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Meter log</h2>
        {readings.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <Card className="divide-y divide-line">
            {readings.map((reading) => (
              <div key={reading.id} className="flex items-baseline gap-4 px-4 py-3 text-sm">
                <time className="w-40 shrink-0 text-muted" dateTime={reading.recorded_at}>
                  {new Date(reading.recorded_at).toLocaleString()}
                </time>
                <div className="flex flex-1 flex-wrap gap-x-6 gap-y-1">
                  {reading.hobbs ? <span>Hobbs <Meter value={reading.hobbs} /></span> : null}
                  {reading.tach ? <span>Tach <Meter value={reading.tach} /></span> : null}
                  {reading.airframe_hours ? (
                    <span>Airframe <Meter value={reading.airframe_hours} /></span>
                  ) : null}
                  {reading.note ? <span className="text-muted">{reading.note}</span> : null}
                </div>
                {/*
                  A superseded reading stays in the log and is labelled rather
                  than hidden: the correction and what it corrected are both
                  part of the trail the maintenance numbers rest on (§3.4).
                */}
                {reading.superseded ? (
                  <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">
                    corrected
                  </span>
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

function Total({
  label,
  value,
  text,
}: {
  label: string;
  value: string | null;
  text?: string;
}) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg">{text ?? <Meter value={value} />}</p>
    </div>
  );
}
