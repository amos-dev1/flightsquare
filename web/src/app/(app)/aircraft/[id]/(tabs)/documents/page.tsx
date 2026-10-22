import { notFound } from 'next/navigation';
import { FileText, Image as ImageIcon } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Alert, Card, Empty, SectionHeading, Status } from '@/components/ui';
import type {
  AircraftDocumentKind,
  AircraftDocumentResponse,
  EntitlementsResponse,
} from '@flightsquare/shared';

import { DocumentForm, RemoveDocument } from './client';
import { DOCUMENT_TYPES } from './types';

/**
 * An aeroplane's paperwork (§3.2).
 *
 * The AROW set is the reason it exists: a pilot is responsible for the
 * airworthiness certificate, registration, operating limitations and weight and
 * balance being aboard. Insurance is not AROW and is here because it is the one
 * a club actually chases — it expires, somebody has to renew it. "Other" is
 * whatever else a club keeps: a 337, an STC, a pitot-static report.
 *
 * **Pilots read it; filing is the admin's.** `documents: read` is in the Pilot
 * bundle (`0027`) and `documents: write` is not, so a pilot sees every
 * document, when it was uploaded and when it expires, and has nothing to add
 * or remove — the buttons are absent, and the API refuses regardless (§8.1).
 *
 * **One list, not a section per type.** It used to be six headed sections each
 * saying "Nothing on file" until filled, which on a new aeroplane was a page of
 * empty boxes. Now nothing on file is an empty tab.
 *
 * **An expired document never grounds the aeroplane**, and the page says so
 * where it shows one (§10, 2026-10-02): a club may have renewed and not
 * uploaded it yet, and §11 forbids inferring airworthiness in either direction.
 */

const NOUN = Object.fromEntries(DOCUMENT_TYPES.map((type) => [type.kind, type.noun])) as Record<
  AircraftDocumentKind,
  string
>;
const ORDER = DOCUMENT_TYPES.map((type) => type.kind);

export default async function AircraftDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let documents: AircraftDocumentResponse[];
  let entitlements: EntitlementsResponse;
  try {
    [documents, entitlements] = await Promise.all([
      apiFetch<AircraftDocumentResponse[]>(`/aircraft/${id}/documents`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  const canWrite = entitlements.permissions.documents === 'write';
  // AROW order, then by name, so the list reads the same way every time.
  const current = documents
    .filter((one) => one.status === 'active' && !one.superseded)
    .sort(
      (a, b) =>
        ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.title.localeCompare(b.title),
    );
  // The history is the admin's to look back through; a pilot needs what is
  // current.
  const past = canWrite
    ? documents.filter((one) => one.superseded || one.status === 'removed')
    : [];
  const expired = current.filter((one) => expiryOf(one.expires_on)?.state === 'expired');

  return (
    <div className="space-y-6">
      {canWrite ? <DocumentForm aircraftId={id} /> : null}

      {expired.length > 0 ? (
        <Alert>
          {expired.length === 1
            ? `${expired[0]!.title} has expired.`
            : `${expired.length} documents have expired: ${expired.map((one) => one.title).join(', ')}.`}{' '}
          This does not affect bookings.
        </Alert>
      ) : null}

      {current.length === 0 ? (
        <Empty title="No documents">
          {canWrite
            ? 'Add the airworthiness certificate, registration, weight and balance or anything else this aircraft carries.'
            : 'Nothing has been filed for this aircraft yet.'}
        </Empty>
      ) : (
        <Card className="divide-y divide-line">
          {current.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              aircraftId={id}
              canWrite={canWrite}
            />
          ))}
        </Card>
      )}

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
  const expiry = expiryOf(document.expires_on);
  // A main type is named by its type; "Other" by what somebody typed, with
  // the type beside it so the list still says what kind of thing it is.
  const typeLabel = document.title === NOUN[document.kind] ? null : NOUN[document.kind];

  return (
    <div className={`space-y-2 px-5 py-4 ${faded ? 'bg-subtle' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-base font-semibold">{document.title}</p>
          <p className="mt-0.5 text-sm text-secondary">
            {typeLabel ? `${typeLabel} · ` : ''}Uploaded{' '}
            <time dateTime={document.created_at}>{dateOf(document.created_at)}</time>
          </p>
        </div>
        {/*
          Expired in red, expiring within sixty days in orange, each with its
          word and icon (§11). "Expired" and never "Grounded": nothing on this
          page touches the aeroplane's dispatch state.
        */}
        {expiry === null ? (
          <span className="text-sm text-secondary">No expiry</span>
        ) : expiry.state === 'expired' ? (
          <Status kind="overdue">Expired {expiry.on}</Status>
        ) : expiry.state === 'soon' ? (
          <Status kind="due_soon">{expiry.label}</Status>
        ) : (
          <span className="tabular text-sm text-secondary">Expires {expiry.on}</span>
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
        <p className="text-sm text-secondary">No file attached.</p>
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
                className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold underline decoration-1 underline-offset-4"
              >
                {file.content_type === 'application/pdf' ? (
                  <FileText aria-hidden size={16} strokeWidth={2} />
                ) : (
                  <ImageIcon aria-hidden size={16} strokeWidth={2} />
                )}
                {file.content_type === 'application/pdf' ? 'Open PDF' : 'Open image'}
              </a>
            </li>
          ))}
        </ul>
      )}

      {canWrite ? <RemoveDocument documentId={document.id} aircraftId={aircraftId} /> : null}
    </div>
  );
}

function dateOf(instant: string): string {
  return new Date(instant).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * How an expiry reads, and what it never says.
 *
 * The word is "Expired" and not "Grounded", in red with its icon once it has
 * passed and orange in the sixty days before. The aeroplane's dispatch state
 * comes from squawks and overdue maintenance items; nothing on this page
 * touches it.
 */
function expiryOf(
  expiresOn: string | null,
): { state: 'expired' | 'soon' | 'later'; on: string; label: string } | null {
  if (expiresOn === null) return null;

  const days = Math.round(
    (new Date(`${expiresOn}T12:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  if (days < 0) return { state: 'expired', on: expiresOn, label: `Expired ${expiresOn}` };
  if (days === 0) return { state: 'soon', on: expiresOn, label: 'Expires today' };
  // Sixty days: the same notice the reminder in the feed goes out on.
  if (days <= 60) return { state: 'soon', on: expiresOn, label: `Expires in ${days} days` };
  return { state: 'later', on: expiresOn, label: `Expires ${expiresOn}` };
}
