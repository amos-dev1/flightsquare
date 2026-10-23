import { apiFetch } from '@/lib/api';
import { Empty, PageTitle, SectionHeading } from '@/components/ui';
import type {
  AircraftResponse,
  EntitlementsResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { SquawkCard } from './card';
import { SquawkForm } from './client';

/**
 * What is wrong with the fleet, and who gets to say it is fixed.
 *
 * A pilot files; closing one or deferring it needs `maintenance: write`
 * (§1.5). That is the whole reason squawks are not part of the maintenance
 * screen — the two acts belong to different people, and a screen that mixed
 * them would quietly suggest otherwise.
 */
export default async function SquawksPage({
  searchParams,
}: {
  searchParams: Promise<{ aircraft?: string }>;
}) {
  // Which aeroplane the person arrived talking about. The Maintenance tab
  // sends it, so somebody who pressed Add squawk on N220SR is not asked
  // again which aeroplane they meant.
  const { aircraft: from } = await searchParams;

  const [squawks, fleet, entitlements] = await Promise.all([
    apiFetch<SquawkResponse[]>('/squawks'),
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  const canClose = entitlements.permissions['maintenance.items'] === 'write';
  const canFile = entitlements.permissions.squawks === 'write';
  const active = fleet.filter((aircraft) => aircraft.status === 'active');

  // Deferred is still an open defect — it is only the grounding that a
  // deferral lifts — so both belong on the outstanding list.
  const open = squawks.filter((squawk) => squawk.status !== 'resolved');
  const resolved = squawks.filter((squawk) => squawk.status === 'resolved');

  return (
    <div className="space-y-6">
      <div>
        <PageTitle>Squawks</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          {open.length === 0
            ? 'Nothing outstanding.'
            : `${open.length} outstanding ${open.length === 1 ? 'squawk' : 'squawks'}.`}
        </p>
      </div>

      {canFile && active.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Report a squawk</SectionHeading>
          <SquawkForm
            fleet={active}
            // Only where it names an aeroplane this member can actually see:
            // an id out of the URL is the caller's, not the server's, and a
            // picker opening on something that is not in the list would show
            // an empty box (§8.1 — the client is untrusted here as anywhere).
            aircraftId={active.some((one) => one.id === from) ? from : undefined}
          />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading>Outstanding</SectionHeading>
        {open.length === 0 ? (
          // With no aircraft there is nothing to report against, and saying
          // "nothing outstanding" twice on one screen tells nobody that.
          active.length === 0 ? (
            <Empty title="No aircraft yet">
              Add one on the fleet page before there is anything to report.
            </Empty>
          ) : (
            <Empty title="No open squawks">
              Anything you or another member reports shows up here.
            </Empty>
          )
        ) : (
          <div className="space-y-3">
            {open.map((squawk) => (
              <SquawkCard key={squawk.id} squawk={squawk} canClose={canClose} />
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Resolved</SectionHeading>
          <div className="space-y-3">
            {resolved.slice(0, 20).map((squawk) => (
              <SquawkCard key={squawk.id} squawk={squawk} canClose={canClose} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
