import { FileText } from 'lucide-react';

import { Card, Status } from '@/components/ui';
import type { SquawkResponse } from '@flightsquare/shared';

import { SquawkActions } from './client';

/*
  One squawk, as both screens that list them show it: the fleet-wide Squawks
  page, and the Maintenance tab of the aeroplane it was filed against. The
  same card in both, so a defect reads the same wherever somebody meets it.
*/

const SEVERITY: Record<SquawkResponse['severity'], string> = {
  advisory: 'Advisory',
  minor: 'Minor',
  major: 'Major',
  grounding: 'Grounding',
};

export function SquawkCard({ squawk, canClose }: { squawk: SquawkResponse; canClose: boolean }) {
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

      {/*
        What the pilot photographed at the aircraft. Filed from the phone
        (§8.2) and read here, because the person deciding whether it grounds
        the aeroplane is usually the one sitting at a desk.

        Full size on click rather than a lightbox: the URL is signed and
        short-lived, so a new tab is the whole of what a bigger view needs.
      */}
      {squawk.attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {squawk.attachments.map((photo) => (
            <li key={photo.id}>
              <a href={photo.url} target="_blank" rel="noreferrer">
                {/*
                  A PDF cannot render in an `<img>`, and one can reach a squawk
                  now that the allowed types include it — somebody attaching a
                  shop report to a defect is a reasonable thing to do. So the
                  non-image case is a tile that says what it is.
                */}
                {photo.content_type === 'application/pdf' ? (
                  <span className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-subtle text-xs font-semibold text-secondary">
                    <FileText aria-hidden size={20} strokeWidth={1.75} />
                    PDF
                  </span>
                ) : (
                  <>
                    {/* Not next/image: the host is object storage, the URL is
                        signed and expires, and neither is something to configure
                        a remote-image loader around. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.url}
                      alt={`Photograph of: ${squawk.summary}`}
                      className="h-20 w-20 rounded-lg border border-line bg-subtle object-cover"
                    />
                  </>
                )}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

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
