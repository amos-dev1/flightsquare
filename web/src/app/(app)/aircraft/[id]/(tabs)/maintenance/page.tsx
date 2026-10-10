import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Plus } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Button, Card, Empty, SectionHeading, Status } from '@/components/ui';
import {
  AvailabilityLine,
  DueStatus,
  governingLabel,
  remainingLabel,
} from '@/app/(app)/maintenance/shared';
import type {
  AircraftAvailabilityResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
  MaintenanceSummaryResponse,
} from '@flightsquare/shared';

/**
 * What this aeroplane owes, and when.
 *
 * Its own tab because it is a different question from "can I take it" and
 * belongs to a different person: the dashboard answers a pilot walking out,
 * this answers whoever signs the work.
 *
 * Two shapes, by permission (§4.4). An admin holds `maintenance.items` and
 * gets every tracked interval with its rules. A Pilot holds
 * `maintenance.summary: read` and `maintenance.items: none`, so asking for the
 * item list would be a 403 by design — the summary endpoint answers instead,
 * with what is coming and nothing about how it is configured.
 */
export default async function AircraftMaintenanceTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let availability: AircraftAvailabilityResponse;
  let entitlements: EntitlementsResponse;
  try {
    [availability, entitlements] = await Promise.all([
      apiFetch<AircraftAvailabilityResponse>(`/aircraft/${id}/availability`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const level = entitlements.permissions['maintenance.items'];
  const canReadItems = level !== 'none';
  const canWriteItems = level === 'write';

  const items = canReadItems
    ? await apiFetch<MaintenanceItemResponse[]>(`/aircraft/${id}/maintenance-items`)
    : [];
  const summary = canReadItems
    ? null
    : await apiFetch<MaintenanceSummaryResponse>(`/aircraft/${id}/maintenance/summary`).catch(
        (error: unknown) => {
          if (error instanceof ApiError) return null;
          throw error;
        },
      );

  const active = items.filter((item) => item.status === 'active');
  /*
    Overdue first, then due soon. An item nobody has recorded compliance for is
    on the list too: "we have no record" is not "it is fine".
  */
  const attention = active
    .filter((item) => item.state === 'overdue' || item.state === 'due_soon' || !item.ever_complied)
    .sort((a, b) => (a.state === 'overdue' ? 0 : 1) - (b.state === 'overdue' ? 0 : 1));
  const rest = active.filter((item) => !attention.includes(item));

  return (
    <div className="space-y-6">
      {/*
        The same dispatch line as the dashboard, repeated deliberately: somebody
        who came straight to this tab to record compliance still needs to know
        whether the aeroplane is flying while they do it.
      */}
      <Card className="p-5">
        <AvailabilityLine row={availability} />
      </Card>

      {canReadItems ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionHeading>Tracked intervals</SectionHeading>
            {canWriteItems ? (
              <Link href={`/maintenance/new?aircraft=${id}`}>
                <Button variant="secondary">
                  <Plus aria-hidden size={16} strokeWidth={2} />
                  Track something
                </Button>
              </Link>
            ) : null}
          </div>

          {active.length === 0 ? (
            /*
              §3.6: "A new aircraft tracks nothing until an admin says so." An
              empty list is a decision nobody has made yet, not a fault — and
              saying so is the difference between an owner thinking the app is
              broken and knowing it is waiting for them.
            */
            <Empty title="Nothing is being tracked yet">
              Annuals, 100-hours, oil changes and ELT batteries are added when you say they
              apply — nothing is assumed about this aeroplane.
            </Empty>
          ) : (
            <div className="space-y-6">
              {attention.length > 0 ? (
                <ItemList title="Needs attention" items={attention} />
              ) : null}
              {rest.length > 0 ? <ItemList title="In hand" items={rest} /> : null}
            </div>
          )}
        </>
      ) : (
        /*
          The Pilot's view: what is coming, and nothing about how it is set up.
          §1.5 keeps `maintenance.summary` and `maintenance.items` apart for
          exactly this — a pilot needs to know before every flight, and the
          record belongs to whoever signs the work.
        */
        <section className="space-y-3">
          <SectionHeading>Coming up</SectionHeading>
          {!summary || summary.upcoming.length === 0 ? (
            <Card className="px-5 py-4 text-sm text-secondary">Nothing due in the near term.</Card>
          ) : (
            <Card className="divide-y divide-line">
              {summary.upcoming.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
                >
                  <span className="text-sm font-semibold">{item.name}</span>
                  <span className="flex items-center gap-3 text-sm text-secondary">
                    {governingLabel(item) ? (
                      <span className="tabular">{governingLabel(item)}</span>
                    ) : null}
                    <Status kind={item.state === 'overdue' ? 'overdue' : 'due_soon'} />
                  </span>
                </div>
              ))}
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

function ItemList({ title, items }: { title: string; items: MaintenanceItemResponse[] }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-secondary">{title}</h3>
      <Card className="divide-y divide-line">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/maintenance/${item.id}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 transition-colors duration-150 hover:bg-subtle"
          >
            <span className="text-sm font-semibold">{item.name}</span>
            <span className="flex items-center gap-3 text-sm text-secondary">
              <span className="tabular">{remainingLabel(item)}</span>
              <DueStatus item={item} />
            </span>
          </Link>
        ))}
      </Card>
    </section>
  );
}
