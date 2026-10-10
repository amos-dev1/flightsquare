import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Card, KeyMetric, SectionHeading, Status } from '@/components/ui';
import { AvailabilityLine, DueStatus, governingLabel } from '@/app/(app)/maintenance/shared';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  EntitlementsResponse,
  MaintenanceSummaryResponse,
  SquawkResponse,
} from '@flightsquare/shared';


/**
 * Can I take it, what is wrong with it, and what do the meters read.
 *
 * The dispatch question first, because it is what the person opening this
 * screen is actually asking. Settings and the maintenance record are their own
 * tabs — this one is for the member standing next to the aeroplane.
 */
export default async function AircraftDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ logged?: string }>;
}) {
  const { id } = await params;
  const { logged } = await searchParams;

  let aircraft: AircraftResponse;
  let availability: AircraftAvailabilityResponse;
  let entitlements: EntitlementsResponse;
  let squawks: SquawkResponse[];
  try {
    [aircraft, availability, entitlements, squawks] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<AircraftAvailabilityResponse>(`/aircraft/${id}/availability`),
      apiFetch<EntitlementsResponse>('/entitlements'),
      // V1_SCOPE M5: open squawks are visible to every member here, because
      // the next pilot needs to know what the last one found.
      apiFetch<SquawkResponse[]>(`/squawks?aircraft_id=${id}&open=true`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  /*
    §1.5 built `maintenance.summary` for exactly this: "whether the aeroplane
    is fit to fly and what is coming up: a pilot needs it before every
    flight". It answers for a Pilot holding `maintenance.items: none` as well
    as for an admin, which is why it is this endpoint and not the item list.

    Null rather than a throw where the module is gated off (§1.6 answers 404),
    and the section is simply absent.
  */
  const summary =
    entitlements.permissions['maintenance.summary'] === 'none'
      ? null
      : await apiFetch<MaintenanceSummaryResponse>(
          `/aircraft/${id}/maintenance/summary`,
        ).catch((error: unknown) => {
          if (error instanceof ApiError) return null;
          throw error;
        });

  // §3.6: "the earliest wins", and the server has already sorted worst first.
  // Three, because this is a glance on the way out to the aeroplane and the
  // whole list is one tap away.
  const upcoming = summary?.upcoming.slice(0, 3) ?? [];

  return (
    <div className="space-y-6">
      {/* §11: a success state, stated near where the work happened. */}
      {logged ? (
        <Alert tone="info">
          Flight saved. The meters below now show the readings you entered.
        </Alert>
      ) : null}

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
        Dispatch state before anything else, because it is the question the
        person opening this screen is actually asking. It is the same view the
        scheduler will consult (§3.3), so the answer here and the answer a
        booking gets cannot disagree.

        §11: never infer "Airworthy" from the absence of a warning. This says
        "available", which is a claim about this product's records, and it
        lists what it is relying on. What is *due* lives on the Maintenance
        tab; this is only whether it flies today.
      */}
      <section className="space-y-3">
        <SectionHeading>Maintenance due</SectionHeading>
        <Card className="divide-y divide-line">
          {/*
            Dispatch first, and it stays however the heading reads. §11:
            never infer airworthiness from an absence of maintenance
            warnings — so a list of what is coming up cannot be the only
            thing here, or a short list would read as reassurance. This line
            is a claim about this product's records and says so, and it is
            the same one the scheduler consults (§3.3), so the answer here
            and the answer a booking gets cannot disagree.
          */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-5">
            {/*
              Labelled, because under a heading that says "Maintenance due" a
              bare "Available" chip reads as a maintenance verdict and is not
              one. It answers a different question — can this aeroplane be
              taken *now* — and the list below answers what it owes later.
            */}
            <span className="text-sm text-secondary">Can it be flown today?</span>
            <AvailabilityLine row={availability} />
          </div>

          {upcoming.length > 0 ? (
            upcoming.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
              >
                <span className="text-sm font-semibold">{item.name}</span>
                <span className="flex items-center gap-3 text-sm text-secondary">
                  {/* The server's number, named with its unit. §8.2 keeps the
                      client out of a maintenance countdown — this only says
                      which unit the figure it sent is in. */}
                  {governingLabel(item) ? (
                    <span className="tabular">{governingLabel(item)}</span>
                  ) : null}
                  {/*
                    The item's own state, never inferred from its position in
                    the list. The summary returns the next five worst-first,
                    which on a well-kept aeroplane is five items that are all
                    fine — labelling those "Due soon" would be a warning
                    nobody asked for, and §11 keeps routine statuses
                    restrained. The same chip the Maintenance tab uses, so the
                    two screens cannot disagree about one item.
                  */}
                  <DueStatus item={item} />
                </span>
              </div>
            ))
          ) : (
            <p className="px-5 py-4 text-sm text-secondary">
              {/*
                Not "nothing due". §11: never infer airworthiness from an
                absence of maintenance warnings, and this is where that would
                happen — a club adds an aeroplane, never sets up its
                intervals, and a reassuring empty state tells a pilot
                everything is in hand when nobody has told us anything.

                `upcoming` is the next five *whatever their state*, including
                the ones that are fine, so an empty list is not an aeroplane
                with nothing coming up. It is an aeroplane tracking nothing —
                §3.6: "A new aircraft tracks nothing until an admin says so."
              */}
              {summary === null
                ? 'Nothing to show.'
                : 'Nothing is being tracked on this aeroplane yet.'}
            </p>
          )}

          <div className="px-5 py-3">
            <Link
              href={`/aircraft/${id}/maintenance`}
              className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              {upcoming.length > 0 ? 'Everything that is tracked' : 'What is tracked'}
            </Link>
          </div>
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
                {squawk.grounding && squawk.status === 'open' ? <Status kind="grounded" /> : null}
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
          className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Report a defect
        </Link>
        {/*
          §3.4's whole pilot-logbook story: an export, not a feature. Your own
          rows, so you can transcribe them into the logbook you actually keep.
        */}
        <a
          href="/flights-export"
          className="ml-4 inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Download your flights
        </a>
      </section>

      {/*
        §3.2's paperwork, which a pilot is responsible for having aboard and
        has had no way to check. Everyone reads it — `documents: read` is in
        the Pilot bundle — and filing is the admin's.
      */}
      {entitlements.permissions.documents === 'none' ? null : (
        <section className="space-y-3">
          <SectionHeading>Documents</SectionHeading>
          <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-sm text-secondary">
              Airworthiness certificate, registration, weight and balance, insurance.
            </p>
            <Link
              href={`/aircraft/${id}/documents`}
              className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              See what is on file
            </Link>
          </Card>
        </section>
      )}

    </div>
  );
}
