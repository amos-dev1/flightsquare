import Link from 'next/link';

import { apiFetch } from '@/lib/api';
import { Button, Card, Empty, Meter } from '@/components/ui';
import type { AircraftResponse } from '@flightsquare/shared';

export default async function FleetPage() {
  const fleet = await apiFetch<AircraftResponse[]>('/aircraft');
  const active = fleet.filter((a) => a.status === 'active');
  const inactive = fleet.filter((a) => a.status !== 'active');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Fleet</h1>
        <Link href="/aircraft/new">
          <Button>Add aircraft</Button>
        </Link>
      </div>

      {fleet.length === 0 ? (
        <Empty title="No aircraft yet">
          Add one to start tracking hours and maintenance.
        </Empty>
      ) : (
        <div className="space-y-6">
          <ul className="space-y-3">
            {active.map((aircraft) => (
              <AircraftRow key={aircraft.id} aircraft={aircraft} />
            ))}
          </ul>

          {inactive.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Archived
              </h2>
              <ul className="space-y-3">
                {inactive.map((aircraft) => (
                  <AircraftRow key={aircraft.id} aircraft={aircraft} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AircraftRow({ aircraft }: { aircraft: AircraftResponse }) {
  return (
    <li>
      <Link href={`/aircraft/${aircraft.id}`} className="block">
        <Card className="flex items-center gap-4 p-4 transition hover:border-accent/40">
          <div className="flex-1">
            <p className="font-medium tracking-tight">
              {aircraft.registration}
              {aircraft.status !== 'active' ? (
                <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">
                  {aircraft.status}
                </span>
              ) : null}
            </p>
            <p className="text-sm text-muted">
              {aircraft.type_code ?? 'Unknown type'}
              {aircraft.home_base ? ` · ${aircraft.home_base}` : ''}
            </p>
          </div>
          <dl className="hidden gap-6 text-sm sm:flex">
            <div>
              <dt className="text-xs text-muted">Hobbs</dt>
              <dd>
                <Meter value={aircraft.hobbs} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Tach</dt>
              <dd>
                <Meter value={aircraft.tach} />
              </dd>
            </div>
          </dl>
        </Card>
      </Link>
    </li>
  );
}
