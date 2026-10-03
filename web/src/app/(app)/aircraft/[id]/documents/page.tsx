import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Image as ImageIcon } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, SectionHeading } from '@/components/ui';
import type {
  AircraftDocumentKind,
  AircraftDocumentResponse,
  AircraftResponse,
  EntitlementsResponse,
} from '@flightsquare/shared';

import { DocumentForm, RemoveDocument } from './client';

/**
 * An aeroplane's paperwork (§3.2).
 *
 * The AROW set is the reason it exists: a pilot is responsible for the
 * airworthiness certificate, registration, operating limitations and weight and
 * balance being aboard. Insurance is not AROW and is here because it is the one
 * a club actually chases — it expires, somebody has to renew it, and the
 * reminder is most of the value of storing a date beside a file.
 *
 * **Pilots read it; filing is the admin's.** `documents: read` has been in the
 * Pilot bundle since `0027` with nothing using it.
 *
 * **A lapsed document never grounds the aeroplane**, and every line is worded
 * so nobody concludes otherwise. §11 forbids inferring airworthiness from an
 * absence of warnings, and the mirror binds just as hard.
 */

const ORDER: AircraftDocumentKind[] = [
  'airworthiness',
  'registration',
  'operating_limitations',
  'weight_balance',
  'insurance',
  'other',
];

const NOUN: Record<AircraftDocumentKind, string> = {
  airworthiness: 'Airworthiness certificate',
  registration: 'Registration',
  operating_limitations: 'Operating limitations',
  weight_balance: 'Weight and balance',
  insurance: 'Insurance',
  other: 'Other',
};

/** Which have a date to count down to at all. */
const EXPIRES: Record<AircraftDocumentKind, boolean> = {
  airworthiness: false,
  registration: true,
  operating_limitations: false,
  weight_balance: false,
  insurance: true,
  other: true,
};

export default async function AircraftDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let aircraft: AircraftResponse;
  let documents: AircraftDocumentResponse[];
  let entitlements: EntitlementsResponse;
  try {
    [aircraft, documents, entitlements] = await Promise.all([
      apiFetch<AircraftResponse>(`/aircraft/${id}`),
      apiFetch<AircraftDocumentResponse[]>(`/aircraft/${id}/documents`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  const canWrite = entitlements.permissions.documents === 'write';
  const current = documents.filter((one) => one.status === 'active' && !one.superseded);
  const past = documents.filter((one) => one.superseded || one.status === 'removed');

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/aircraft/${id}`}
          className="text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          {aircraft.registration}
        </Link>
        <PageTitle>Documents</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          What should be aboard, and what the club has on file.{' '}
          <span className="font-semibold">Nothing here affects bookings.</span>
        </p>
      </div>

      {documents.length === 0 && !canWrite ? (
        <Empty title="Nothing on file">
          Your account admin files the aircraft&apos;s paperwork here.
        </Empty>
      ) : null}

      {ORDER.map((kind) => {
        const held = current.filter((one) => one.kind === kind);
        if (held.length === 0 && !canWrite) return null;

        return (
          <section key={kind} className="space-y-3">
            <SectionHeading>{NOUN[kind]}</SectionHeading>

            {held.length === 0 ? (
              <Card className="px-5 py-4 text-sm text-secondary">
                Nothing on file.{EXPIRES[kind] ? '' : ' This one does not expire.'}
              </Card>
            ) : (
              <Card className="divide-y divide-line">
                {held.map((document) => (
                  <DocumentRow
                    key={document.id}
                    document={document}
                    aircraftId={id}
                    canWrite={canWrite}
                  />
                ))}
              </Card>
            )}

            {canWrite ? <DocumentForm aircraftId={id} kind={kind} /> : null}
          </section>
        );
      })}

      {past.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Replaced and removed</SectionHeading>
          {/* Kept, never deleted (§10): last year's certificate is what answers
              a question about last year, and an insurer will ask. */}
          <p className="text-sm text-secondary">
            Kept on file. Last year&apos;s certificate is what answers a question about last year.
          </p>
          <Card className="divide-y divide-line">
            {past.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                aircraftId={id}
                canWrite={false}
                faded
              />
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

function DocumentRow({
  document,
  aircraftId,
  canWrite,
  faded,
}: {
  document: AircraftDocumentResponse;
  aircraftId: string;
  canWrite: boolean;
  faded?: boolean;
}) {
  const expiry = expiryWording(document.expires_on);

  return (
    <div className={`space-y-2 px-5 py-4 ${faded ? 'bg-subtle' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base font-semibold">{document.title}</p>
        {expiry ? (
          <span className={`text-sm ${expiry.emphatic ? 'font-semibold' : 'text-secondary'}`}>
            {expiry.label}
          </span>
        ) : (
          <span className="text-sm text-secondary">No expiry</span>
        )}
      </div>

      {document.reference ? (
        <p className="tabular text-sm text-secondary">{document.reference}</p>
      ) : null}
      {document.notes ? <p className="text-sm">{document.notes}</p> : null}

      {document.status === 'removed' ? (
        <p className="text-sm font-semibold">Removed — {document.removed_reason}</p>
      ) : document.superseded ? (
        <p className="text-sm text-secondary">Replaced by a newer one</p>
      ) : null}

      {document.attachments.length === 0 ? (
        <p className="text-sm text-secondary">Recorded, not scanned yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {document.attachments.map((file) => (
            <li key={file.id}>
              {/* A PDF cannot render in an `<img>`, so neither does. Both open
                  the signed link, which is good for a few minutes only. */}
              <a
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-semibold underline decoration-1 underline-offset-4"
              >
                {file.content_type === 'application/pdf' ? (
                  <FileText aria-hidden size={16} strokeWidth={2} />
                ) : (
                  <ImageIcon aria-hidden size={16} strokeWidth={2} />
                )}
                Open
              </a>
            </li>
          ))}
        </ul>
      )}

      {canWrite ? <RemoveDocument documentId={document.id} aircraftId={aircraftId} /> : null}
    </div>
  );
}

/**
 * How an expiry reads, and what it never says.
 *
 * Weight rather than colour when it has passed, and the word is "Expired" and
 * not "Grounded". The aeroplane's dispatch state comes from squawks and overdue
 * maintenance items; nothing on this page touches it.
 */
function expiryWording(expiresOn: string | null): { label: string; emphatic: boolean } | null {
  if (expiresOn === null) return null;

  const days = Math.round(
    (new Date(`${expiresOn}T12:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  if (days < 0) return { label: `Expired ${expiresOn}`, emphatic: true };
  if (days === 0) return { label: 'Expires today', emphatic: true };
  if (days <= 60) return { label: `Expires in ${days} days`, emphatic: true };
  return { label: `Expires ${expiresOn}`, emphatic: false };
}
