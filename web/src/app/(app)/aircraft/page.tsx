import Link from 'next/link';
import { Fuel, Plus, PlaneTakeoff } from 'lucide-react';

import { apiFetch, ApiError } from '@/lib/api';
import { Button, Card, Empty, Meter, PageTitle, Status } from '@/components/ui';
import type {
  AircraftAvailabilityResponse,
  AircraftResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
  MaintenanceSummaryResponse,
  SquawkResponse,
} from '@flightsquare/shared';

/**
 * The fleet, and whether each aeroplane can fly.
 *
 * A registration and two meters was a list of things, not a dispatch board.
 * What a member actually asks before walking out is: can I take it, what is
 * wrong with it, what is coming up, and how much fuel is in it — so the row
 * answers those, and the meters stay.
 */
export default async function FleetPage() {
  const [fleet, entitlements, availability] = await Promise.all([
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<EntitlementsResponse>('/entitlements'),
    apiFetch<AircraftAvailabilityResponse[]>('/availability'),
  ]);

  /*
    Open squawks, fleet-wide, in one request rather than one per aeroplane.
    `open=true` is the API's own filter, so "open" means what the API means by
    it rather than something this page decides.
  */
  const squawks = await apiFetch<SquawkResponse[]>('/squawks?open=true').catch(
    (error: unknown) => {
      // A member without `squawks: read` gets a 403 here, and a fleet list is
      // still worth rendering without the defect counts.
      if (error instanceof ApiError) return [] as SquawkResponse[];
      throw error;
    },
  );

  /*
    The same split the maintenance page makes, for the same reason: a Pilot
    holds `maintenance.summary: read` and `maintenance.items: none` (§4.4), so
    asking for the item list would be a 403 by design. The summary endpoint
    they do hold answers instead, one aeroplane at a time.
  */
  const canReadItems = entitlements.permissions['maintenance.items'] !== 'none';
  const items = canReadItems
    ? await apiFetch<MaintenanceItemResponse[]>('/maintenance').catch((error: unknown) => {
        if (error instanceof ApiError) return [] as MaintenanceItemResponse[];
        throw error;
      })
    : [];
  const summaries = canReadItems
    ? []
    : await Promise.all(
        fleet.map((aircraft) =>
          apiFetch<MaintenanceSummaryResponse>(
            `/aircraft/${aircraft.id}/maintenance/summary`,
          ).catch((error: unknown) => {
            // One aeroplane's summary failing must not blank the fleet.
            if (error instanceof ApiError) return null;
            throw error;
          }),
        ),
      );

  const active = fleet.filter((a) => a.status === 'active');
  const inactive = fleet.filter((a) => a.status !== 'active');
  const soleAircraft = active.length === 1 ? active[0] : undefined;

  /*
    §4.3: free is one aeroplane, and adding a second answers 402 with a
    machine-readable body. Offering a button that cannot work is worse than
    not offering it — §1.6 is explicit that upsell copy belongs in the UI
    rather than in an error code, and this is the UI's half of that.

    Read from the resolved quota (§1.4), never from the plan name: the moment
    a plan code appears in a conditional the whole entitlement chain stops
    meaning anything. `current` is counted in the database (§4.5), so this is
    the same number the API will check.
  */
  const quota = entitlements.quotas['aircraft.active'];
  const atLimit =
    quota !== undefined && quota.limit !== 'unlimited' && (quota.current ?? 0) >= quota.limit;
  const canAdd = entitlements.permissions.aircraft === 'write' && !atLimit;

  const statusFor = (aircraftId: string) => ({
    availability: availability.find((row) => row.aircraft_id === aircraftId),
    openSquawks: squawks.filter((squawk) => squawk.aircraft_id === aircraftId).length,
    maintenance: canReadItems
      ? worstOf(items.filter((item) => item.aircraft_id === aircraftId).map((i) => i.state))
      : worstOf(
          (summaries.find((s) => s?.aircraft_id === aircraftId)?.upcoming ?? []).map(
            (u) => u.state,
          ),
        ),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageTitle>Fleet</PageTitle>

        {/*
          §11 allows one dominant primary per section, so which action gets it
          depends on what the tenant is here to do. With a single aircraft —
          the solo owner this release is built for — that is logging a flight,
          not adding a second one.
        */}
        <div className="flex items-center gap-3">
          {soleAircraft ? (
            <Link href={`/aircraft/${soleAircraft.id}/log-flight`}>
              <Button>
                <PlaneTakeoff aria-hidden size={16} strokeWidth={2} />
                Log flight
              </Button>
            </Link>
          ) : null}
          {canAdd ? (
            <Link href="/aircraft/new">
              <Button variant={soleAircraft ? 'secondary' : 'primary'}>
                <Plus aria-hidden size={16} strokeWidth={2} />
                Add aircraft
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      {fleet.length === 0 ? (
        <Empty title="No aircraft yet">
          Add one to start tracking hours and maintenance.
        </Empty>
      ) : (
        <div className="space-y-6">
          <ul className="space-y-3">
            {active.map((aircraft) => (
              <AircraftRow key={aircraft.id} aircraft={aircraft} {...statusFor(aircraft.id)} />
            ))}
          </ul>

          {inactive.length > 0 ? (
            <section>
              <h2 className="mb-3 text-xl font-semibold tracking-tight">Archived</h2>
              <ul className="space-y-3">
                {inactive.map((aircraft) => (
                  <AircraftRow key={aircraft.id} aircraft={aircraft} {...statusFor(aircraft.id)} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {/*
        Said once, under the list, rather than as a disabled button nobody can
        explain. §5.3 wants the way out offered, and the member who can act on
        it is the one who holds `subscription`.
      */}
      {atLimit && entitlements.permissions.aircraft === 'write' ? (
        <p className="text-sm text-secondary">
          Your plan covers {quota?.limit} aircraft
          {entitlements.permissions.subscription !== 'none' ? (
            <>
              {' — '}
              <Link
                href="/settings/subscription"
                className="font-semibold underline decoration-1 underline-offset-2"
              >
                change your plan
              </Link>{' '}
              to add another.
            </>
          ) : (
            '. An admin can change the plan to add another.'
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Worst state wins — a fleet row reports the thing that stops the aeroplane. */
function worstOf(states: string[]): 'overdue' | 'due_soon' | null {
  if (states.includes('overdue')) return 'overdue';
  if (states.includes('due_soon')) return 'due_soon';
  return null;
}

function AircraftRow({
  aircraft,
  availability,
  openSquawks,
  maintenance,
}: {
  aircraft: AircraftResponse;
  availability?: AircraftAvailabilityResponse;
  openSquawks: number;
  maintenance: 'overdue' | 'due_soon' | null;
}) {
  const grounded = availability ? !availability.available : false;

  return (
    <li>
      <Link href={`/aircraft/${aircraft.id}`} className="block">
        <Card className="flex flex-wrap items-center gap-4 p-5 transition-colors duration-150 hover:bg-subtle">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
              {aircraft.registration}
              {aircraft.status !== 'active' ? (
                <Status kind="neutral">{aircraft.status}</Status>
              ) : null}
              {/*
                §11: never colour alone, and never infer airworthiness from the
                absence of a warning — so these say what they are, and a row
                with no flags claims nothing beyond "nothing is flagged".
              */}
              {grounded ? <Status kind="grounded" /> : null}
              {maintenance === 'overdue' ? <Status kind="overdue">Maintenance overdue</Status> : null}
              {maintenance === 'due_soon' ? <Status kind="due_soon">Maintenance due soon</Status> : null}
              {openSquawks > 0 ? (
                <Status kind="neutral">
                  {openSquawks} open squawk{openSquawks === 1 ? '' : 's'}
                </Status>
              ) : null}
            </p>
            <p className="mt-0.5 text-sm text-secondary">
              {aircraft.type_code ?? 'Unknown type'}
              {aircraft.home_base ? ` · ${aircraft.home_base}` : ''}
            </p>
            {/*
              Why it is grounded, not just that it is. The view resolves three
              causes into one answer (§3.3) and the reason is what decides
              whether a member rings the shop or the chief pilot.
            */}
            {grounded && availability && availability.grounding_reasons.length > 0 ? (
              <p className="mt-1 text-sm">{availability.grounding_reasons.join(' · ')}</p>
            ) : null}
          </div>

          {/* Numbers right-aligned and labelled; Hobbs and tach never implied
              by position alone. */}
          <dl className="hidden gap-8 text-sm sm:flex">
            <div className="text-right">
              <dt className="text-xs font-medium text-secondary">Hobbs</dt>
              <dd className="mt-0.5 font-semibold">
                <Meter value={aircraft.hobbs} />
              </dd>
            </div>
            <div className="text-right">
              <dt className="text-xs font-medium text-secondary">Tach</dt>
              <dd className="mt-0.5 font-semibold">
                <Meter value={aircraft.tach} />
              </dd>
            </div>
            {/*
              §3.4: fuel is aircraft *state*, latest reading wins, and it is
              never computed across flights. Shown with its units because a
              number alone is ambiguous between gallons and litres, and shown
              as a dash when nobody has recorded one — an empty tank and an
              unknown tank are different things.
            */}
            <div className="text-right">
              <dt className="flex items-center justify-end gap-1 text-xs font-medium text-secondary">
                <Fuel aria-hidden size={12} strokeWidth={2} />
                Fuel
              </dt>
              <dd className="mt-0.5 font-semibold">
                {aircraft.fuel_remaining === null ? (
                  <span className="text-secondary">—</span>
                ) : (
                  <span className="tabular">
                    {aircraft.fuel_remaining}
                    <span className="ml-1 text-xs font-normal text-secondary">
                      {aircraft.fuel_units === 'litres' ? 'L' : 'gal'}
                    </span>
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </Link>
    </li>
  );
}
