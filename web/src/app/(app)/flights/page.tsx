import Link from 'next/link';
import { Download, PlaneTakeoff } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, Status } from '@/components/ui';
import type {
  AircraftResponse,
  EntitlementsResponse,
  FlightResponse,
} from '@flightsquare/shared';

/**
 * What the fleet has flown.
 *
 * This screen is the other half of §3.4's core loop, and until now it did not
 * exist: flights were write-only from the UI, `GET /flights` had no caller
 * anywhere in the product, and `needs_review` — the flag §8.2 raises when a
 * Hobbs start does not match the last reading — could be set by the API and
 * read by nobody. A meter gap is "real information, usually a maintenance run
 * or an unlogged flight", and information nobody can see is not information.
 *
 * Filters live in the URL rather than in state, the way the calendar's do, so
 * a treasurer chasing one aeroplane's hours can send somebody the list they
 * are looking at.
 */
export default async function FlightsPage({
  searchParams,
}: {
  searchParams: Promise<{ aircraft?: string; mine?: string; review?: string }>;
}) {
  const filters = await searchParams;

  const query = new URLSearchParams();
  if (filters.aircraft) query.set('aircraft_id', filters.aircraft);
  if (filters.mine === 'true') query.set('mine', 'true');
  if (filters.review === 'true') query.set('needs_review', 'true');

  const [flights, fleet, entitlements] = await Promise.all([
    apiFetch<FlightResponse[]>(query.toString() ? `/flights?${query}` : '/flights'),
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  // Everyone can log a flight (§4.4 gives both bundles `flights: write`), so
  // this is about where the button points, not whether it appears.
  const active = fleet.filter((aircraft) => aircraft.status === 'active');
  // Bound rather than indexed inline: `active[0]` is `T | undefined` under
  // noUncheckedIndexedAccess, and this is the narrowing the link needs.
  const soleActive = active.length === 1 ? active[0] : undefined;
  const flagged = flights.filter((flight) => flight.needs_review).length;

  const href = (next: Partial<typeof filters>): string => {
    const params = new URLSearchParams();
    const merged = { ...filters, ...next };
    if (merged.aircraft) params.set('aircraft', merged.aircraft);
    if (merged.mine === 'true') params.set('mine', 'true');
    if (merged.review === 'true') params.set('review', 'true');
    const search = params.toString();
    return search ? `/flights?${search}` : '/flights';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>Flights</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {flights.length === 0
              ? 'Nothing logged for this filter.'
              : `${flights.length} flight${flights.length === 1 ? '' : 's'}, most recent first.`}
            {/* The API caps this, and a list that silently stops is worse
                than one that says it has. */}
            {flights.length === 200 ? ' Showing the most recent 200.' : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/*
            §3.4 calls the post-flight entry "the most important screen in the
            product" — the one filled in at a tiedown — and it was reachable
            only by going to the fleet and picking the aeroplane first. With
            one aeroplane this goes straight there; with several it goes to
            the fleet to choose, because which one flew is the first thing the
            form needs and guessing it would be worse than asking.

            Hidden with nothing to log against, and hidden for a member who
            cannot log flights — though §8.1 is clear that is cosmetics and
            the API refuses either way.
          */}
          {active.length > 0 && entitlements.permissions.flights !== 'none' ? (
            <Link
              href={soleActive ? `/aircraft/${soleActive.id}/log-flight` : '/aircraft'}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-navy px-4 text-sm font-semibold text-on-dark hover:bg-navy-hover"
            >
              <PlaneTakeoff aria-hidden size={16} strokeWidth={2} />
              Log a flight
            </Link>
          ) : null}

          {/*
            §3.4: "A CSV export of a member's own flight rows is a reasonable
            convenience so they can transcribe into their real logbook. That is
            the extent of the pilot-logbook story." Own rows only, whatever
            this screen is filtered to.
          */}
          <a
            href="/flights-export"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-control px-4 text-sm font-semibold hover:bg-subtle"
          >
            <Download aria-hidden size={16} strokeWidth={2} />
            Download your flights
          </a>
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 text-sm">
        <Filter href={href({ mine: undefined, aircraft: undefined, review: undefined })} on={!filters.mine && !filters.aircraft && filters.review !== 'true'}>
          Everything
        </Filter>
        <Filter href={href({ mine: filters.mine === 'true' ? undefined : 'true' })} on={filters.mine === 'true'}>
          Mine
        </Filter>
        <Filter
          href={href({ review: filters.review === 'true' ? undefined : 'true' })}
          on={filters.review === 'true'}
        >
          Needs review{flagged > 0 && filters.review !== 'true' ? ` (${flagged})` : ''}
        </Filter>

        {active.length > 1 ? (
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-secondary">·</span>
            {active.map((aircraft) => (
              <Filter
                key={aircraft.id}
                href={href({
                  aircraft: filters.aircraft === aircraft.id ? undefined : aircraft.id,
                })}
                on={filters.aircraft === aircraft.id}
              >
                <span className="uppercase">{aircraft.registration}</span>
              </Filter>
            ))}
          </span>
        ) : null}
      </Card>

      {flights.length === 0 ? (
        <Empty title="No flights here">
          {filters.mine || filters.aircraft || filters.review ? (
            <>
              Nothing matches that filter.{' '}
              <Link href="/flights" className="font-semibold underline decoration-1 underline-offset-2">
                Show everything
              </Link>
              .
            </>
          ) : (
            'Log one from an aircraft and the meters advance with it.'
          )}
        </Empty>
      ) : (
        <Card className="divide-y divide-line">
          {flights.map((flight) => (
            <FlightRow key={flight.id} flight={flight} />
          ))}
        </Card>
      )}

      <p className="text-xs text-secondary">
        {/* §3.4: recorded as read, and neither derived from the other. The
            difference between them is real data about how it was flown. */}
        Hobbs and tach are recorded as read. Neither is derived from the other,
        and the difference between them is real.
      </p>
    </div>
  );
}

function Filter({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      // §11: a selected state is weight and an underline as well as the teal
      // marker, never colour on its own.
      //
      // `min-h-11` because these are the page's primary control and measured
      // 20px tall — §13 asks for 44. The row is `flex-wrap` with its own gaps,
      // so the taller target costs no horizontal space and cannot overlap the
      // link beside it.
      className={`inline-flex min-h-11 items-center ${
        on
          ? 'font-semibold underline decoration-teal decoration-2 underline-offset-4'
          : 'text-secondary hover:text-navy'
      }`}
      aria-current={on ? 'true' : undefined}
    >
      {children}
    </Link>
  );
}

function FlightRow({ flight }: { flight: FlightResponse }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-4">
      <time className="tabular w-24 shrink-0 text-sm text-secondary" dateTime={flight.flight_date}>
        {flight.flight_date}
      </time>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          <span className="uppercase">{flight.aircraft_registration}</span>
          {flight.departed_from || flight.arrived_at ? (
            <span className="ml-2 font-normal text-secondary">
              {flight.departed_from ?? '—'} → {flight.arrived_at ?? '—'}
            </span>
          ) : null}
          {flight.needs_review ? (
            <span className="ml-2">
              <Status kind="due_soon">Needs review</Status>
            </span>
          ) : null}
        </p>

        {/*
          `break-words`: the pilot is identified by email here, and an address
          is one unbreakable token. `min-w-0 flex-1` on the parent lets the box
          shrink but cannot split the word inside it, so at 390px a
          38-character address pushed the whole page 9px wide — the last
          horizontal scroll left in the app.
        */}
        <p className="mt-0.5 break-words text-xs text-secondary">
          {/* No name on this projection — the flights join carries the email
              and nothing else, which is enough to say who had the aeroplane. */}
          {flight.flown_by_email ?? 'Unknown pilot'}
          {flight.remarks ? ` · ${flight.remarks}` : ''}
        </p>

        {flight.needs_review && flight.review_reason ? (
          <p className="mt-1 max-w-prose text-xs">
            {/* §8.2: a gap is a flag for a person, never a rejection, and it
                is usually a maintenance run or a flight nobody logged. */}
            {flight.review_reason}
          </p>
        ) : null}
      </div>

      <div className="tabular shrink-0 text-right text-sm">
        <p>
          {flight.hobbs_hours ? (
            <>
              <span className="font-semibold">{flight.hobbs_hours}</span>
              <span className="text-secondary"> hobbs</span>
            </>
          ) : (
            <span className="text-secondary">no hobbs</span>
          )}
        </p>
        <p className="text-xs text-secondary">
          {flight.tach_hours ? `${flight.tach_hours} tach` : 'no tach'}
        </p>
      </div>
    </div>
  );
}
