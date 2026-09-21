import { apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type { AerodromeResponse, AircraftTypeResponse } from '@flightsquare/shared';

import { NewAircraftForm } from './form';

/**
 * A server component so the reference lists can be fetched with the session,
 * exactly as the log-flight screen does. The browser cannot call the API
 * itself — the token lives in an httpOnly cookie only this server reads — so
 * anything the form needs to offer has to arrive with the page.
 */
export default async function NewAircraftPage() {
  // Global reference data (§2.2): the same for every tenant, and small
  // enough at present to send whole rather than search as you type.
  const [types, aerodromes] = await Promise.all([
    apiFetch<AircraftTypeResponse[]>('/reference/aircraft-types'),
    apiFetch<AerodromeResponse[]>('/reference/aerodromes'),
  ]);

  return (
    <div className="space-y-6">
      <PageTitle>Add aircraft</PageTitle>
      <NewAircraftForm types={types} aerodromes={aerodromes} />
    </div>
  );
}
