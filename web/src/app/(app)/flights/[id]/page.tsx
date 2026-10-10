import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Card, Meter, PageTitle, SectionHeading, Status } from '@/components/ui';
import type { AircraftResponse, FlightResponse } from '@flightsquare/shared';

import { CorrectFlight } from './client';

/**
 * One flight, and what was done about it.
 *
 * Web has never had this screen. The list rendered plain rows with nothing to
 * open, so a flight was something you could log and then only ever see three
 * numbers of — and `needs_review`, the flag §8.2 raises when a Hobbs start
 * does not meet the last reading, had nowhere to be acted on.
 *
 * It is also where a correction has to live, because a correction is about
 * one flight and needs every field of it in front of you.
 */
export default async function FlightPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ corrected?: string }>;
}) {
  const { id } = await params;
  const { corrected } = await searchParams;

  let flight: FlightResponse;
  try {
    flight = await apiFetch<FlightResponse>(`/flights/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const aircraft = await apiFetch<AircraftResponse>(`/aircraft/${flight.aircraft_id}`);
  const unit = aircraft.fuel_units === 'litres' ? 'L' : 'gal';

  const route =
    flight.departed_from || flight.arrived_at
      ? `${flight.departed_from ?? '—'} → ${flight.arrived_at ?? '—'}`
      : 'No route recorded';

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/aircraft/${flight.aircraft_id}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-text underline underline-offset-2"
        >
          {flight.aircraft_registration}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <PageTitle>{route}</PageTitle>
          {flight.logged_in_error ? <Status kind="neutral">Logged in error</Status> : null}
          {flight.superseded_by ? <Status kind="neutral">Corrected</Status> : null}
          {flight.needs_review && !flight.superseded_by ? (
            <Status kind="due_soon">Needs review</Status>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-secondary">
          <time dateTime={flight.flight_date}>{flight.flight_date}</time>
          {' · '}
          {flight.flown_by_email ?? 'Unknown pilot'}
        </p>
      </div>

      {corrected ? (
        <Alert tone="info">
          Correction saved. The entry it replaced is still on the log, below.
        </Alert>
      ) : null}

      {/*
        §8.2: a gap is a flag for a person, never a rejection — usually a
        maintenance run or a flight nobody logged. Said here, where somebody
        can do something about it.
      */}
      {flight.needs_review && flight.review_reason && !flight.superseded_by ? (
        <Alert tone="info">{flight.review_reason}</Alert>
      ) : null}

      {/*
        The correction chain, both ways. §3.4 keeps both rows, so both are
        reachable — a trail nobody can follow is not one.
      */}
      {flight.superseded_by ? (
        <Card className="px-5 py-4 text-sm">
          <p className="font-semibold">This entry was corrected.</p>
          <p className="mt-1 text-secondary">
            It stays on the log as written. The figures below are not what the aeroplane is
            counting.
          </p>
          <Link
            href={`/flights/${flight.superseded_by}`}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
          >
            See the entry that replaced it
          </Link>
        </Card>
      ) : null}

      {flight.supersedes_id ? (
        <Card className="px-5 py-4 text-sm">
          <p className="font-semibold">
            {flight.logged_in_error ? 'This flight did not happen.' : 'This is a correction.'}
          </p>
          {flight.correction_reason ? (
            <p className="mt-1 text-secondary">&ldquo;{flight.correction_reason}&rdquo;</p>
          ) : null}
          <Link
            href={`/flights/${flight.supersedes_id}`}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
          >
            See the entry it replaced
          </Link>
        </Card>
      ) : null}

      {/*
        §11: Hobbs and tach are named rather than left to column position.
        They run at different rates by design and the difference between them
        is real data about how the aeroplane was flown.
      */}
      {flight.logged_in_error ? null : (
        <section className="space-y-3">
          <SectionHeading>Hours</SectionHeading>
          <Card className="grid grid-cols-1 gap-px overflow-hidden bg-line sm:grid-cols-2">
            <MeterRow
              label="Hobbs"
              start={flight.hobbs_start}
              end={flight.hobbs_end}
              hours={flight.hobbs_hours}
            />
            <MeterRow
              label="Tach"
              start={flight.tach_start}
              end={flight.tach_end}
              hours={flight.tach_hours}
            />
          </Card>
          <p className="text-xs text-secondary">
            Recorded as read. Neither is worked out from the other.
          </p>
        </section>
      )}

      {flight.fuel_remaining_after || flight.fuel_added_qty ? (
        <section className="space-y-3">
          <SectionHeading>Fuel</SectionHeading>
          <Card className="divide-y divide-line">
            {/* §3.4: state and transaction, and never one field. */}
            {flight.fuel_remaining_after ? (
              <Line label={`Remaining at shutdown (${unit})`}>
                <Meter value={flight.fuel_remaining_after} />
              </Line>
            ) : null}
            {flight.fuel_added_qty ? (
              <Line label={`Added (${unit})`}>
                <Meter value={flight.fuel_added_qty} />
              </Line>
            ) : null}
            {flight.fuel_added_cost_cents !== null ? (
              <Line label="Cost">
                <span className="tabular">
                  {(flight.fuel_added_cost_cents / 100).toFixed(2)} {flight.currency ?? 'USD'}
                </span>
              </Line>
            ) : null}
          </Card>
        </section>
      ) : null}

      {flight.remarks ? (
        <section className="space-y-3">
          <SectionHeading>Notes</SectionHeading>
          <Card className="px-5 py-4 text-sm">{flight.remarks}</Card>
        </section>
      ) : null}

      {/*
        §8.1: hiding is cosmetics. `correctable` is resolved by the server —
        your own flight while nothing has been flown since, or an
        administrator — and the API refuses either way.
      */}
      {flight.superseded_by ? null : (
        <CorrectFlight flight={flight} aircraft={aircraft} />
      )}
    </div>
  );
}

function MeterRow({
  label,
  start,
  end,
  hours,
}: {
  label: string;
  start: string | null;
  end: string | null;
  hours: string | null;
}) {
  return (
    <div className="bg-surface p-5">
      <p className="text-sm font-semibold">{label}</p>
      {end === null ? (
        <p className="mt-2 text-sm text-secondary">Not fitted, or not read.</p>
      ) : (
        <dl className="mt-2 flex gap-6 text-sm">
          <div>
            <dt className="text-xs text-secondary">Out</dt>
            <dd className="tabular">{start ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-secondary">In</dt>
            <dd className="tabular">{end}</dd>
          </div>
          <div>
            <dt className="text-xs text-secondary">Hours</dt>
            <dd className="tabular font-semibold">{hours ?? '—'}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-3 text-sm">
      <span className="text-secondary">{label}</span>
      {children}
    </div>
  );
}
