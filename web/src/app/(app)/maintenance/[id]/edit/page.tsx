import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type {
  AircraftResponse,
  EntitlementsResponse,
  MaintenanceItemResponse,
} from '@flightsquare/shared';

import { MaintenanceItemForm } from '../../item-form';

/**
 * Editing an item.
 *
 * The intervals are editable; the due points are not. They are derived from the
 * intervals and the last compliance on record, and a form that let somebody type
 * one in directly would be a form that could put an aeroplane's next annual
 * wherever it liked. Every change here lands in the item's append-only log (§7).
 */
export default async function EditMaintenanceItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let item: MaintenanceItemResponse;
  let entitlements: EntitlementsResponse;
  try {
    [item, entitlements] = await Promise.all([
      apiFetch<MaintenanceItemResponse>(`/maintenance-items/${id}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }
  if (entitlements.permissions['maintenance.items'] !== 'write') notFound();

  const aircraft = await apiFetch<AircraftResponse>(`/aircraft/${item.aircraft_id}`);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/maintenance/${item.id}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          {item.name}
        </Link>
        <PageTitle>Edit tracked item</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          On {aircraft.registration}. Changing an interval moves the due point with it.
        </p>
      </div>

      <MaintenanceItemForm
        aircraftId={item.aircraft_id}
        registration={aircraft.registration}
        item={item}
      />
    </div>
  );
}
