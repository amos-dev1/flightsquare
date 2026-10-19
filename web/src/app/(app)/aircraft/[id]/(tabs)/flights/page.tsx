import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, Empty, SectionHeading, Status } from '@/components/ui';
import type {
  EntitlementsResponse,
  FlightResponse,
  FlightSummaryResponse,
} from '@flightsquare/shared';

/**
 * What this aeroplane has flown, and who had it.
 *
 * The fleet-wide list exists at `/flights` and filters by aircraft, but a club
 * reconciling one aeroplane's hours was being sent off its page to do it. §3.4
 * makes `flown_by` the accountability record — "who had the plane, who owes
 * for it" — so this is the answer to both questions in one place.
 *
 * **Everybody's flights, not the reader's.** §4.4 gives `flights` scope `all`
 * to both bundles deliberately, because who flew what is how a club
 * reconciles its meters and its money. `0010` is explicit that narrowing it
 * "would be a different product", so there is no `mine` filter here.
 */
export default async function AircraftFlightsTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let flights: FlightResponse[];
  let summary: FlightSummaryResponse;
  let entitlements: EntitlementsResponse;
  try {
    [flights, summary, entitlements] = await Promise.all([
      apiFetch<FlightResponse[]>(`/flights?aircraft_id=${id}`),
      // §8.2: the totals are the server's. Adding up the list here would be
      // wrong past the 200 rows it caps at, and wrong in the direction
      // nobody notices.
      apiFetch<FlightSummaryResponse>(`/flights/summary?aircraft_id=${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      {/*
        §3.4: Hobbs and tach are recorded as read and neither is derived from
        the other, so a total has to say which it is — "hours" on its own is
        two different numbers.
      */}
      <Card className="grid grid-cols-3 gap-px overflow-hidden bg-line">
        <Figure label="Flights" value={summary.flights} />
        <Figure label="Hobbs hours" value={summary.hobbs_hours} />
        <Figure label="Tach hours" value={summary.tach_hours} />
      </Card>

      {flights.length === 0 ? (
        <Empty title="Nothing logged yet">
          Every flight logged against this aeroplane shows here, whoever flew it — the hours,
          the route and the pilot.
        </Empty>
      ) : (
        <section className="space-y-3">
          <SectionHeading>Every flight</SectionHeading>
          <Card className="divide-y divide-line">
            {flights.map((flight) => (
              <FlightRow
                key={flight.id}
                flight={flight}
                showPhotoGaps={entitlements.permissions.aircraft === 'write'}
              />
            ))}
          </Card>
          {/*
            The list caps at 200 server-side, and saying so is the difference
            between a club thinking they have seen everything and knowing
            where to look for the rest.
          */}
          {flights.length >= 200 ? (
            <p className="text-xs text-secondary">
              The most recent 200. The figures above count them all.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface p-5">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

/*
  0042: the aeroplane asked for a meter photo and none arrived. Shown to
  whoever administers the fleet — the same `aircraft: write` that may
  correct any flight — because they are the one who follows it up; the
  pilot sees it on the flight itself, where they can add the photo.
*/
function FlightRow({
  flight,
  showPhotoGaps,
}: {
  flight: FlightResponse;
  showPhotoGaps: boolean;
}) {
  // Corrected and in-error entries stay on the list, labelled, with their
  // figures struck: §3.4 keeps both rows and a trail missing the half that
  // was wrong is not one.
  const replaced = flight.superseded_by !== null;

  return (
    <Link
      href={`/flights/${flight.id}`}
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-4 transition-colors duration-150 hover:bg-subtle"
    >
      <time className="tabular w-24 shrink-0 text-sm text-secondary" dateTime={flight.flight_date}>
        {flight.flight_date}
      </time>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {flight.departed_from ?? '—'} → {flight.arrived_at ?? '—'}
          {flight.needs_review && !replaced ? (
            <span className="ml-2">
              <Status kind="due_soon">Needs review</Status>
            </span>
          ) : null}
          {showPhotoGaps && flight.meter_photo_missing ? (
            <span className="ml-2">
              <Status kind="due_soon">Meter photo missing</Status>
            </span>
          ) : null}
          {flight.logged_in_error ? (
            <span className="ml-2">
              <Status kind="neutral">Logged in error</Status>
            </span>
          ) : null}
          {replaced ? (
            <span className="ml-2">
              <Status kind="neutral">Corrected</Status>
            </span>
          ) : null}
        </p>

        {/*
          `break-words`: the pilot is identified by email and an address is one
          unbreakable token, which pushes the page wide at 390px otherwise.
        */}
        <p className="mt-0.5 break-words text-xs text-secondary">
          {flight.flown_by_email ?? 'Unknown pilot'}
          {flight.remarks ? ` · ${flight.remarks}` : ''}
        </p>

        {flight.supersedes_id && flight.correction_reason ? (
          <p className="mt-0.5 break-words text-xs text-secondary">
            {flight.logged_in_error ? 'Taken back' : 'Correction'} &middot;{' '}
            &ldquo;{flight.correction_reason}&rdquo;
          </p>
        ) : null}
      </div>

      <div
        className={`tabular shrink-0 text-right text-sm ${
          replaced || flight.logged_in_error ? 'text-secondary line-through' : ''
        }`}
      >
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
    </Link>
  );
}
