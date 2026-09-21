'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button, Card } from '@/components/ui';

/**
 * Where a failed render or a failed action lands.
 *
 * Without this file, anything thrown inside the app — a server action that
 * could not reach the API, a page whose fetch returned a 500 — renders Next's
 * unstyled error screen with no way back. §11 asks for an error state near
 * the thing that failed, and for a way out of it.
 *
 * `retry` rather than `reset`: this version of Next re-fetches and re-renders
 * the segment, which is what a person clicking "Try again" actually means.
 * `reset` only clears the boundary without re-fetching.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Dev sees the real error in the terminal; production sends a digest and
    // nothing else, which is why the digest is shown below.
    console.error(error);
  }, [error]);

  return (
    <Card className="p-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <AlertTriangle aria-hidden size={20} strokeWidth={2} />
        That did not work
      </h1>

      <p className="mt-2 text-sm text-secondary">
        Something failed while loading or saving. Nothing you entered was lost from the
        database — this is the screen, not your records.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        {/* A full reload, for the case where retrying the segment is not
            enough — a stale session, most often. */}
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>

      {error.digest ? (
        <p className="mt-4 text-xs text-secondary">
          Reference <span className="tabular">{error.digest}</span>
        </p>
      ) : null}
    </Card>
  );
}
