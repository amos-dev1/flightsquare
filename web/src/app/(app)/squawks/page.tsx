import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, SectionHeading, Status } from '@/components/ui';
import type {
  AircraftResponse,
  EntitlementsResponse,
  SquawkResponse,
} from '@flightsquare/shared';

import { SquawkActions, SquawkForm } from './client';

/**
 * What is wrong with the fleet, and who gets to say it is fixed.
 *
 * A pilot files; closing one or deferring it needs `maintenance: write`
 * (§1.5). That is the whole reason squawks are not part of the maintenance
 * screen — the two acts belong to different people, and a screen that mixed
 * them would quietly suggest otherwise.
 */
export default async function SquawksPage() {
  const [squawks, fleet, entitlements] = await Promise.all([
    apiFetch<SquawkResponse[]>('/squawks'),
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  const canClose = entitlements.permissions.maintenance === 'write';
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
            : `${open.length} outstanding ${open.length === 1 ? 'defect' : 'defects'}.`}
        </p>
      </div>

      {canFile && active.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Report a defect</SectionHeading>
          <SquawkForm fleet={active} />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading>Outstanding</SectionHeading>
        {open.length === 0 ? (
          <Empty title="Nothing outstanding">
            Anything reported on a flight shows up here.
          </Empty>
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

const SEVERITY: Record<SquawkResponse['severity'], string> = {
  advisory: 'Advisory',
  minor: 'Minor',
  major: 'Major',
  grounding: 'Grounding',
};

function SquawkCard({ squawk, canClose }: { squawk: SquawkResponse; canClose: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <p className="text-base font-semibold">{squawk.summary}</p>
          <p className="mt-0.5 text-sm text-secondary">
            {/* Registrations stay uppercase; §11 reserves it for exactly this. */}
            {squawk.aircraft_registration} · {SEVERITY[squawk.severity]} ·{' '}
            {squawk.reported_by_email ?? 'a member'} ·{' '}
            <time dateTime={squawk.reported_at}>
              {new Date(squawk.reported_at).toLocaleDateString()}
            </time>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Grounding is stated in words and carries an icon, never colour
              alone, and it is separate from severity because it is a separate
              judgement (§3.6). */}
          {squawk.grounding && squawk.status === 'open' ? <Status kind="grounded" /> : null}
          {squawk.status === 'deferred' ? <Status kind="neutral">Deferred</Status> : null}
          {squawk.status === 'resolved' ? <Status kind="available">Resolved</Status> : null}
        </div>
      </div>

      {squawk.details ? <p className="mt-3 text-sm">{squawk.details}</p> : null}

      {squawk.resolution_note ? (
        <p className="mt-3 text-sm text-secondary">Resolution: {squawk.resolution_note}</p>
      ) : null}

      {/*
        The whole deferral history, not just the current one. §7.2 names it
        among the records read back after an accident, which is also why
        lifting a deferral leaves its row exactly where it was.
      */}
      {squawk.deferrals.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-secondary">
          {squawk.deferrals.map((deferral) => (
            <li key={deferral.id}>
              Deferred{' '}
              <time dateTime={deferral.deferred_at}>
                {new Date(deferral.deferred_at).toLocaleDateString()}
              </time>{' '}
              under {deferral.basis === 'far_91_213' ? '14 CFR 91.213' : deferral.basis.toUpperCase()}
              {deferral.reference ? ` (${deferral.reference})` : ''}
              {deferral.expires_on ? ` until ${deferral.expires_on}` : ''}
              {deferral.note ? ` — ${deferral.note}` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {canClose ? <SquawkActions squawk={squawk} /> : null}
    </Card>
  );
}
