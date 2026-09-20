import Link from 'next/link';

import { apiFetch } from '@/lib/api';
import { Plus } from 'lucide-react';

import { Button, Card, Empty, Meter, PageTitle, Status } from '@/components/ui';
import type { AircraftResponse } from '@flightsquare/shared';

export default async function FleetPage() {
  const fleet = await apiFetch<AircraftResponse[]>('/aircraft');
  const active = fleet.filter((a) => a.status === 'active');
  const inactive = fleet.filter((a) => a.status !== 'active');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageTitle>Fleet</PageTitle>
        <Link href="/aircraft/new">
          {/* §11: specific labels, one dominant primary per section. */}
          <Button>
            <Plus aria-hidden size={16} strokeWidth={2} />
            Add aircraft
          </Button>
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
              <h2 className="mb-3 text-xl font-semibold tracking-tight">Archived</h2>
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
        <Card className="flex items-center gap-4 p-5 transition-colors duration-150 hover:bg-subtle">
          <div className="flex-1">
            <p className="flex items-center gap-2 text-base font-semibold">
              {aircraft.registration}
              {aircraft.status !== 'active' ? (
                <Status kind="neutral">{aircraft.status}</Status>
              ) : null}
            </p>
            <p className="mt-0.5 text-sm text-secondary">
              {aircraft.type_code ?? 'Unknown type'}
              {aircraft.home_base ? ` · ${aircraft.home_base}` : ''}
            </p>
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
          </dl>
        </Card>
      </Link>
    </li>
  );
}
