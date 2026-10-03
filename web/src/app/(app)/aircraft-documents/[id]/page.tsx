import { notFound, redirect } from 'next/navigation';

import { ApiError, apiFetch } from '@/lib/api';
import type { AircraftDocumentResponse } from '@flightsquare/shared';

/**
 * A tap from the bell, resolved.
 *
 * A notice about a certificate coming up for renewal carries the document's id
 * and no aeroplane — and the list is what somebody needs to see, because a
 * renewal is filed beside the one it replaces. One lookup rather than a page
 * that asks every aircraft whether it owns the thing.
 */
export default async function ResolveDocument({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const document = await apiFetch<AircraftDocumentResponse>(`/aircraft-documents/${id}`);
    redirect(`/aircraft/${document.aircraft_id}/documents`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }
}
