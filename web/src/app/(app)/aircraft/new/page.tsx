import { apiFetch } from '@/lib/api';
import { PageTitle } from '@/components/ui';
import type { AircraftTypeResponse } from '@flightsquare/shared';

import { NewAircraftForm } from './form';

/**
 * A server component so the reference lists can be fetched with the session,
 * exactly as the log-flight screen does. The browser cannot call the API
 * itself — the token lives in an httpOnly cookie only this server reads — so
 * anything the form needs to offer has to arrive with the page.
 */
export default async function NewAircraftPage() {
  /**
   * Types come whole — thirty-four rows, and the field is a foreign key, so
   * the complete list is both small and the actual set of valid answers.
   *
   * Aerodromes no longer do. The import job took that table to seventy
   * thousand rows and the endpoint caps at a hundred, so the form searches as
   * you type instead (see `searchAerodromes`).
   */
  const types = await apiFetch<AircraftTypeResponse[]>('/reference/aircraft-types');

  return (
    <div className="space-y-6">
      <PageTitle>Add aircraft</PageTitle>
      <NewAircraftForm types={types} />
    </div>
  );
}
