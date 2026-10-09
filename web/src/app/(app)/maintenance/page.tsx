import Link from 'next/link';
import { Plus } from 'lucide-react';

import { apiFetch, ApiError } from '@/lib/api';
import { Card, Empty, PageTitle, Status } from '@/components/ui';
import type {
  AircraftAvailabilityResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
  MaintenanceSummaryResponse,
} from '@flightsquare/shared';

import { SeedButton } from './client';
import { AvailabilityLine, DueStatus, kindFor, remainingIn, ruleSummary } from './shared';

/**
 * What the fleet owes, worst first — the screen a club looks at on a Monday
 * morning, and the one that answers "can we fly this weekend" before anyone
 * drives to the airport.
 *
 * Two screens behind one route, and the split is a permission rather than a
 * role name (§1.5). An admin gets the record: every tracked item, what it is
 * due on, and the way in to adding one. A pilot gets the aeroplane: whether it
 * flies, what is coming up, and nothing about the record — which is SPEC §3's
 * line and the reason `maintenance.summary` and `maintenance.items` are
 * separate resources.
 *
 * Every number here was computed by the API. §8.2: the client never computes
 * anything that matters, and what is due, what is overdue, and what that means
 * for dispatch all matter.
 */
export default async function MaintenancePage() {
  const [availability, entitlements] = await Promise.all([
    apiFetch<AircraftAvailabilityResponse[]>('/availability'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  const level = entitlements.permissions['maintenance.items'];
  const canReadItems = level !== 'none';
  const canWrite = level === 'write';

  // A pilot's 403 on the item list is the permission model working, not a
  // failure to load — so the request is simply not made, and the summary
  // endpoint they do hold answers instead.
  const items = canReadItems ? await apiFetch<MaintenanceItemResponse[]>('/maintenance') : [];

  const summaries = canReadItems
    ? []
    : await Promise.all(
        availability.map((aircraft) =>
          apiFetch<MaintenanceSummaryResponse>(
            `/aircraft/${aircraft.aircraft_id}/maintenance/summary`,
          ).catch((error: unknown) => {
            // One aeroplane's summary failing must not blank the fleet.
            if (error instanceof ApiError) return null;
            throw error;
          }),
        ),
      );

  const byAircraft = new Map<string, MaintenanceItemResponse[]>();
  for (const item of items) {
    byAircraft.set(item.aircraft_id, [...(byAircraft.get(item.aircraft_id) ?? []), item]);
  }

  const attention = canReadItems
    ? items.filter((item) => item.state === 'overdue' || item.state === 'due_soon').length
    : summaries.filter((one) => one?.upcoming[0]?.state === 'overdue' || one?.upcoming[0]?.state === 'due_soon')
        .length;

  return (
    <div className="space-y-6">
      <div>
        <PageTitle>Maintenance</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          {availability.length === 0
            ? 'Nothing to track yet.'
            : attention === 0
              ? 'Nothing due in the near term.'
              : `${attention} ${attention === 1 ? 'item needs' : 'items need'} attention.`}
        </p>
      </div>

      {availability.length === 0 ? (
        <Empty title="No aircraft yet">
          <Link href="/aircraft/new" className="underline decoration-1 underline-offset-2">
            Add an aircraft
          </Link>{' '}
          and start tracking what it is due for.
        </Empty>
      ) : (
        availability.map((aircraft, index) => {
          const list = byAircraft.get(aircraft.aircraft_id) ?? [];
          const summary = summaries[index] ?? null;

          return (
            <section key={aircraft.aircraft_id} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">
                    <Link
                      href={`/aircraft/${aircraft.aircraft_id}`}
                      // A section heading and the way into the aeroplane, so
                      // it is a navigation target as much as a title.
                      className="inline-flex min-h-11 items-center underline decoration-line decoration-1 underline-offset-4 hover:decoration-navy"
                    >
                      {aircraft.registration}
                    </Link>
                  </h2>
                  <div className="mt-2">
                    <AvailabilityLine row={aircraft} />
                  </div>
                  {/* §4.5: a restriction is not a grounding, and saying so is
                      the difference between not flying and not flying IFR. */}
                  {summary?.restrictions.length ? (
                    <p className="mt-2 text-sm">{summary.restrictions.join(' · ')}</p>
                  ) : null}
                </div>

                {canWrite ? (
                  <Link
                    href={`/maintenance/new?aircraft=${aircraft.aircraft_id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-control px-4 text-sm font-semibold hover:bg-subtle"
                  >
                    <Plus aria-hidden size={16} strokeWidth={2} />
                    Add item
                  </Link>
                ) : null}
              </div>

              {canReadItems ? (
                list.length === 0 ? (
                  <Card className="space-y-1 px-5 py-4">
                    {/*
                      Empty by default, deliberately. An aeroplane arriving with
                      fifteen items nobody approved is the app asserting
                      obligations it cannot know apply (SPEC §1).
                    */}
                    <p className="text-sm font-semibold">Nothing tracked yet</p>
                    <p className="text-sm text-secondary">
                      Add the inspections and services this aircraft is on, and FlightSquare counts
                      them down against the meters your flights already record.
                    </p>
                    {/* The preset library, offered rather than applied. §3.6
                        instantiates copies with no live link back, so editing a
                        preset can never rewrite a club's compliance data. */}
                    {canWrite ? (
                      <div className="pt-2">
                        <SeedButton aircraftId={aircraft.aircraft_id} />
                      </div>
                    ) : null}
                  </Card>
                ) : (
                  <Card className="divide-y divide-line">
                    {list.map((item) => (
                      <Link
                        key={item.id}
                        href={`/maintenance/${item.id}`}
                        className="block px-5 py-4 hover:bg-subtle"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <p className="text-base font-semibold">
                            {item.name}
                            {/* §4.5: which items stop the aeroplane, said in
                                words beside the chip rather than in a colour. */}
                            {item.grounds_aircraft ? (
                              <span className="ml-2 text-xs font-medium text-secondary">
                                grounds the aircraft
                              </span>
                            ) : null}
                          </p>
                          <DueStatus item={item} />
                        </div>

                        <p className="mt-1 text-sm text-secondary">
                          <span className="tabular">{ruleSummary(item.rules)}</span>
                          {item.ever_complied ? (
                            <>
                              {' · '}
                              <span className="tabular">
                                {remainingIn(item.governing_kind, item.governing_remaining)}
                              </span>
                            </>
                          ) : (
                            // "No record" and "overdue" are different claims,
                            // and only one of them is about the aeroplane.
                            ' · no compliance recorded'
                          )}
                          {item.projected_date ? (
                            <>
                              {' · at this pace, '}
                              <time className="tabular" dateTime={item.projected_date}>
                                {item.projected_date}
                              </time>
                            </>
                          ) : null}
                        </p>

                        {item.regulatory_reference ? (
                          <p className="mt-1 text-xs text-secondary">{item.regulatory_reference}</p>
                        ) : null}
                      </Link>
                    ))}
                  </Card>
                )
              ) : (
                /* Mockup 02: the next five, and nothing about the record. */
                <Card className="divide-y divide-line">
                  {summary === null || summary.upcoming.length === 0 ? (
                    <p className="px-5 py-4 text-sm text-secondary">Nothing outstanding.</p>
                  ) : (
                    summary.upcoming.map((item) => (
                      <div
                        key={item.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4"
                      >
                        <p className="text-sm font-semibold">{item.name}</p>
                        <span className="flex items-center gap-3">
                          <span className="tabular text-sm text-secondary">
                            {item.ever_complied
                              ? remainingIn(item.governing_kind, item.governing_remaining)
                              : 'no record'}
                          </span>
                          <Status kind={kindFor(item.state)} />
                        </span>
                      </div>
                    ))
                  )}
                </Card>
              )}
            </section>
          );
        })
      )}

      {canReadItems ? null : (
        <p className="text-sm text-secondary">
          Full maintenance records are kept by your account admin.
        </p>
      )}
    </div>
  );
}
