import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Button, Card, KeyMetric, SectionHeading, Status } from '@/components/ui';
import { DueStatus, duePointLabel, remainingIn } from '@/app/(app)/maintenance/shared';
import type {
  AircraftAvailabilityResponse,
  AircraftFlightStatsResponse,
  AircraftResponse,
  EntitlementsResponse,
  FlightResponse,
  MaintenanceSummaryResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { MonthlyHoursChart } from './monthly-hours-chart';

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

  /*
    What the aeroplane has been doing. Both bundles hold `flights: read`
    (§4.4), so in practice everybody sees these; a bundle without it gets
    neither section rather than an error.

    `standing=true` because this is a glance at what happened — the Flights
    tab is where both halves of a correction are kept side by side (§3.4).
  */
  const canReadFlights = entitlements.permissions.flights !== 'none';
  const [recent, stats] = canReadFlights
    ? await Promise.all([
        apiFetch<FlightResponse[]>(`/flights?aircraft_id=${id}&standing=true&limit=3`),
        apiFetch<AircraftFlightStatsResponse>(`/aircraft/${id}/flight-stats`).catch(
          (error: unknown) => {
            if (error instanceof ApiError) return null;
            throw error;
          },
        ),
      ])
    : [[], null];

  /*
    Who flew it, only once there is more than one person it could have been.
    A solo owner's every flight is their own, and their name on each row is
    noise (the "unused, never unavailable" rule in CLAUDE.md, applied to a
    column). This is the tenant's counted membership, data like any other
    quota — never its archetype (§3.1) — plus the rows themselves, so a
    flight by somebody since removed still says who it was.
  */
  const multiPilot =
    (entitlements.quotas['members.active']?.current ?? 1) > 1 ||
    new Set(recent.map((flight) => flight.flown_by)).size > 1;

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
          // The API's percent of usable capacity, absent where none is set.
          note={
            aircraft.fuel_remaining_percent != null
              ? `${aircraft.fuel_remaining_percent}% of usable`
              : null
          }
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
          {upcoming.length > 0 ? (
            upcoming.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{item.name}</p>
                  {/*
                    When it comes due, on the basis it is due on: a reading to
                    watch on the panel, or a date for the diary. §11 names the
                    meter, because Hobbs and tach run at different rates and
                    "due at 1110.0" means nothing without saying which.
                  */}
                  <p className="tabular mt-0.5 text-xs text-secondary">
                    {duePointLabel({ ...item, kind: item.governing_kind })}
                  </p>
                </div>
                <span className="flex items-center gap-3 text-sm text-secondary">
                  {/* How far away, in the governing rule's own units and
                      rounded the way §4.3 asks. The arithmetic is the
                      server's (§8.2); this only says which unit the figure it
                      sent is in. */}
                  <span className="tabular">
                    {remainingIn(item.governing_kind, item.governing_remaining)}
                  </span>
                  {/*
                    The item's own state, never inferred from its position in
                    the list. The summary returns the next five worst-first,
                    which on a well-kept aeroplane is five items that are all
                    fine — labelling those "Due soon" would be a warning
                    nobody asked for, and §11 keeps routine statuses
                    restrained. The same chip the Maintenance tab uses, so the
                    two screens cannot disagree about one item.

                    `compliance={false}` drops the "Not recorded" badge, which
                    belongs on the record screen rather than here: this is the
                    glance on the way out to the aeroplane, and what it has to
                    answer is *when*, not how the item was set up. The
                    Maintenance tab still says it.
                  */}
                  <DueStatus item={item} compliance={false} />
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

          {/* A button rather than an underlined sentence: it is the way on to
              the whole list, and on a phone it wants to look tappable. Secondary,
              because Log flight is this screen's one primary action (§11 §6). */}
          <div className="px-5 py-3">
            <Link href={`/aircraft/${id}/maintenance`}>
              <Button variant="secondary">All maintenance</Button>
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
        {/*
          Filing one lives on the Maintenance tab, beside the rest of what is
          wrong with this aeroplane, rather than here. This section reports
          what the last pilot found; it is not where the next one writes.

          The flights export moved off this screen for the same reason — §3.4
          calls it the whole of the pilot-logbook story and it is a once-a-
          month errand, not something belonging on the dispatch glance.
        */}
      </section>

      {canReadFlights ? (
        // `min-w-0` on both columns: a grid item will not shrink below its
        // content, so the chart's first-render width would otherwise set the
        // column's, and the chart then measures the column it has widened.
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="min-w-0 space-y-3">
            <SectionHeading>Recent flights</SectionHeading>
            <Card className="divide-y divide-line">
              {recent.length === 0 ? (
                <p className="px-5 py-4 text-sm text-secondary">Nothing logged yet.</p>
              ) : (
                recent.map((flight) => (
                  <RecentFlight key={flight.id} flight={flight} showPilot={multiPilot} />
                ))
              )}
              {recent.length > 0 ? (
                <div className="px-5 py-3">
                  <Link
                    href={`/aircraft/${id}/flights`}
                    className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
                  >
                    Every flight
                  </Link>
                </div>
              ) : null}
            </Card>
          </section>

          {stats ? (
            <AircraftStats
              stats={stats}
              // §3.4: neither meter is derived from the other, and §11 says
              // which one a figure is in. Hobbs where the aeroplane has one —
              // it is what most clubs fly and bill on — and tach for the
              // aeroplane that only has a tach.
              meter={aircraft.hobbs === null && aircraft.tach !== null ? 'tach' : 'hobbs'}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One of the last few flights: when, where from and to, and — where it could
 * have been more than one person — who.
 */
function RecentFlight({ flight, showPilot }: { flight: FlightResponse; showPilot: boolean }) {
  const route =
    flight.departed_from || flight.arrived_at
      ? `${flight.departed_from ?? '—'} → ${flight.arrived_at ?? '—'}`
      : 'Route not recorded';

  return (
    <Link
      href={`/flights/${flight.id}`}
      className="flex items-baseline gap-4 px-5 py-3 transition-colors duration-150 hover:bg-subtle"
    >
      <time className="tabular w-24 shrink-0 text-sm text-secondary" dateTime={flight.flight_date}>
        {flight.flight_date}
      </time>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{route}</p>
        {/* `break-words`: with no name given the email stands in, and an
            address is one unbreakable token at 390px. */}
        {showPilot ? (
          <p className="mt-0.5 break-words text-xs text-secondary">
            {flight.flown_by_name ?? flight.flown_by_email ?? 'Unknown pilot'}
          </p>
        ) : null}
      </div>
      {/* §11: the meter is named, because Hobbs and tach are two numbers. */}
      <p className="tabular shrink-0 text-right text-sm">
        {flight.hobbs_hours ? (
          <>
            <span className="font-semibold">{flight.hobbs_hours}</span>
            <span className="text-secondary"> hobbs</span>
          </>
        ) : flight.tach_hours ? (
          <>
            <span className="font-semibold">{flight.tach_hours}</span>
            <span className="text-secondary"> tach</span>
          </>
        ) : null}
      </p>
    </Link>
  );
}

/**
 * How the aeroplane is being used. Every figure is the server's (§8.2); this
 * only chooses which meter to show and says what each one rests on.
 */
function AircraftStats({
  stats,
  meter,
}: {
  stats: AircraftFlightStatsResponse;
  meter: 'hobbs' | 'tach';
}) {
  const meterName = meter === 'hobbs' ? 'Hobbs' : 'Tach';
  const year = stats.as_of.slice(0, 4);
  const { year_to_date: ytd, fuel_burn: burn } = stats;
  const flownInWindow = stats.monthly_hours.some((month) => month.flights > 0);

  const burnRate = meter === 'hobbs' ? burn.per_hobbs_hour : burn.per_tach_hour;
  const fuelUnit = burn.units === 'litres' ? 'L' : 'gal';

  return (
    <section className="min-w-0 space-y-3">
      <SectionHeading>Aircraft stats</SectionHeading>
      <Card className="divide-y divide-line">
        {/*
          Each month's total rather than an average of them: an average hides
          the thing a club actually wants to see, which is the summer peak and
          the winter it sat in the hangar.
        */}
        <div className="px-5 py-4">
          <p className="text-sm font-semibold">Hours flown per month</p>
          <p className="mt-0.5 text-xs text-secondary">{meterName} · last 12 months</p>
          {flownInWindow ? (
            <div className="mt-3">
              <MonthlyHoursChart months={stats.monthly_hours} meter={meter} asOf={stats.as_of} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-secondary">No flights in the last 12 months.</p>
          )}
        </div>
        <StatRow
          label="Year to date"
          note={`${meterName} · ${ytd.flights} ${ytd.flights === 1 ? 'flight' : 'flights'} in ${year}`}
          value={meter === 'hobbs' ? ytd.hobbs_hours : ytd.tach_hours}
          unit="hrs"
        />
        {/*
          Said to be an estimate, and what it rests on, because it is: gauge
          readings a pilot wrote down, before and after (§3.4 — pilots
          estimate, gauges lie). Not a fuel-flow measurement and not to be
          planned on.
        */}
        <StatRow
          label="Average fuel burn"
          note={
            burnRate === null
              ? 'Needs fuel recorded before and after on 3 flights'
              : `Estimate · per ${meterName} hour · from ${burn.flights} flights`
          }
          value={burnRate}
          unit={`${fuelUnit}/hr`}
        />
      </Card>
    </section>
  );
}

function StatRow({
  label,
  note,
  value,
  unit,
}: {
  label: string;
  note: string;
  value: string | null;
  unit: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-0.5 text-xs text-secondary">{note}</p>
      </div>
      <p className="tabular shrink-0 text-2xl font-semibold">
        {value === null ? (
          <span className="text-secondary">—</span>
        ) : (
          <>
            {value}
            <span className="ml-1 text-sm font-normal text-secondary">{unit}</span>
          </>
        )}
      </p>
    </div>
  );
}
