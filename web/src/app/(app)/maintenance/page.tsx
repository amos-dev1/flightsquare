import Link from 'next/link';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle } from '@/components/ui';
import type {
  AircraftAvailabilityResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
} from '@flightsquare/shared';

import { ComplianceForm, SeedButton } from './client';
import { AvailabilityLine, DueStatus, remainingLabel } from './shared';

/**
 * What the fleet owes, worst first — the screen a club looks at on a Monday
 * morning, and the one that answers "can we fly this weekend" before anyone
 * drives to the airport.
 *
 * Every number here was computed by the API. §8.2: the client never computes
 * anything that matters, and what is due, what is overdue, and what that
 * means for dispatch all matter.
 */
export default async function MaintenancePage() {
  const [items, availability, entitlements] = await Promise.all([
    apiFetch<MaintenanceItemResponse[]>('/maintenance'),
    apiFetch<AircraftAvailabilityResponse[]>('/availability'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  // §8.1: the client hides what the user cannot do, and the server enforces
  // it regardless. A Pilot holds `maintenance: read` — they see the whole
  // picture and sign off none of it.
  const canWrite = entitlements.permissions.maintenance === 'write';

  const byAircraft = new Map<string, MaintenanceItemResponse[]>();
  for (const item of items) {
    byAircraft.set(item.aircraft_id, [...(byAircraft.get(item.aircraft_id) ?? []), item]);
  }

  const attention = items.filter(
    (item) => item.state === 'overdue' || item.state === 'due_soon',
  ).length;

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
          and its standard intervals come with it.
        </Empty>
      ) : (
        availability.map((aircraft) => {
          const list = byAircraft.get(aircraft.aircraft_id) ?? [];
          return (
            <section key={aircraft.aircraft_id} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">
                    <Link
                      href={`/aircraft/${aircraft.aircraft_id}`}
                      className="underline decoration-line decoration-1 underline-offset-4 hover:decoration-navy"
                    >
                      {aircraft.registration}
                    </Link>
                  </h2>
                  <div className="mt-2">
                    <AvailabilityLine row={aircraft} />
                  </div>
                </div>
                {canWrite && list.length === 0 ? (
                  <SeedButton aircraftId={aircraft.aircraft_id} />
                ) : null}
              </div>

              {list.length === 0 ? (
                <Card className="px-5 py-4 text-sm text-secondary">
                  No intervals are being tracked for this aircraft.
                </Card>
              ) : (
                <Card className="divide-y divide-line">
                  {list.map((item) => (
                    <div key={item.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-base font-semibold">{item.name}</p>
                        <DueStatus item={item} />
                      </div>

                      {/*
                        A seeded item's due date is an artifact of seeding
                        rather than a fact about the aeroplane, so it is not
                        shown at all until somebody records compliance. §11:
                        the product does not infer airworthiness from silence,
                        and it should not invent a date to fill the silence
                        either.
                      */}
                      {item.ever_complied ? (
                        <p className="mt-1 text-sm text-secondary">
                          <span className="tabular">{remainingLabel(item)}</span>
                          {item.due_on ? (
                            <>
                              {' · due '}
                              <time className="tabular" dateTime={item.due_on}>
                                {item.due_on}
                              </time>
                            </>
                          ) : null}
                          {item.due_at_hours ? (
                            <span className="tabular">
                              {' · at '}
                              {item.due_at_hours} {item.hours_meter} hrs
                            </span>
                          ) : null}
                          {item.grounds_aircraft ? ' · grounds the aircraft when overdue' : null}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm">
                          No compliance recorded yet — enter when this was last done.
                        </p>
                      )}

                      {item.regulatory_reference ? (
                        <p className="mt-1 text-xs text-secondary">{item.regulatory_reference}</p>
                      ) : null}

                      {canWrite ? (
                        <ComplianceForm aircraftId={aircraft.aircraft_id} item={item} />
                      ) : null}
                    </div>
                  ))}
                </Card>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
