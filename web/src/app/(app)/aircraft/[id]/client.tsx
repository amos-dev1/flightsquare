'use client';

import { Archive, Trash2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useState, useTransition } from 'react';

import { logReading, removeAircraftPhoto, setAircraftStatus, type FormState } from '@/app/actions';
import { AircraftPhoto, Alert, Button, Card, Field, Input } from '@/components/ui';
import { FileUpload } from '@/components/upload';

export function ReadingForm({ aircraftId }: { aircraftId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    logReading.bind(null, aircraftId),
    {},
  );

  return (
    <Card className="p-4">
      <form action={action} className="space-y-4">
        {/*
          Three fields, all optional, because a reading carries whatever was
          actually read — a fuel stop logs Hobbs and nothing else, and the
          tach keeps the value it already had.
        */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Hobbs">
            <Input
              name="hobbs"
              inputMode="decimal"
              placeholder="1202.9"
              className="tabular"
              defaultValue={state.values?.hobbs}
            />
          </Field>
          <Field label="Tach">
            <Input
              name="tach"
              inputMode="decimal"
              placeholder="1100.2"
              className="tabular"
              defaultValue={state.values?.tach}
            />
          </Field>
          <Field label="Airframe">
            <Input
              name="airframe_hours"
              inputMode="decimal"
              placeholder="1202.9"
              className="tabular"
              defaultValue={state.values?.airframe_hours}
            />
          </Field>
        </div>

        <Field label="Note" hint="Optional — why this reading, if it needs saying.">
          <Input name="note" maxLength={500} defaultValue={state.values?.note} />
        </Field>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Recorded. The meter log below has it.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record reading'}
        </Button>
      </form>
    </Card>
  );
}

export function ArchiveButton({
  id,
  registration,
  status,
}: {
  id: string;
  registration: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const archived = status !== 'active';

  // Not a destructive action, and not dressed as one: §5.5 makes archiving
  // reversible and non-destructive. No confirmation dialog — §11 reserves
  // those for things that cannot be undone, and this can.
  return (
    <Card className="p-5">
      <h3 className="text-base font-semibold">
        {archived ? 'This aircraft is archived' : 'Archiving'}
      </h3>

      {/*
        What the button actually does, said plainly. Three facts, because all
        three are what somebody is deciding between when they hover over it:
        nothing is lost, it stops being usable, and the plan slot frees up.
      */}
      <p className="mt-2 max-w-prose text-sm text-secondary">
        {archived ? (
          <>
            Its flight and maintenance history is intact and still readable. It cannot be
            used for new flights until you restore it, and it is not counting against your
            plan while archived.
          </>
        ) : (
          <>
            Archiving keeps every flight, meter reading and maintenance record for{' '}
            {registration} and stops it being used for new ones — for an aircraft that has
            been sold, is between owners, or is simply out of service. It frees the slot it
            takes in your plan, and you can restore it at any time.
          </>
        )}
      </p>

      {error ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <div className="mt-4">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await setAircraftStatus(id, archived ? 'active' : 'archived');
              // Restoring can legitimately fail on the quota: the slot this
              // aircraft freed may have been taken by another one since.
              if (result.error) setError(result.error);
            })
          }
        >
          {archived ? (
            <Undo2 aria-hidden size={16} strokeWidth={2} />
          ) : (
            <Archive aria-hidden size={16} strokeWidth={2} />
          )}
          {pending
            ? 'Saving…'
            : archived
              ? `Restore ${registration}`
              : `Archive ${registration}`}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The aeroplane's picture, on its settings (0043).
 *
 * Uploading replaces whatever was there; the API puts the old one aside in the
 * same step. Removing is not a delete either, and says so: the file still
 * counts toward storage because it is still in the bucket (§3.8).
 */
export function AircraftPhotoEditor({
  aircraftId,
  registration,
  photo,
}: {
  aircraftId: string;
  registration: string;
  photo: { url: string } | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();

  return (
    <Card className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:p-6">
      <AircraftPhoto photo={photo} size="lg" alt={`${registration}`} className="sm:w-64" />
      <div className="space-y-3">
        <p className="text-sm text-secondary">
          Shown wherever {registration} appears — the fleet list, this aircraft&rsquo;s pages and
          the phone app. A photo from the side, in daylight, is easiest to recognise.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <FileUpload
            owner={{ kind: 'aircraft', id: aircraftId }}
            fileKind="aircraft_photo"
            label={photo ? 'Replace photo' : 'Upload photo'}
            accept="image/jpeg,image/png,image/heic,image/webp"
            revalidate={`/aircraft/${aircraftId}`}
            onDone={() => router.refresh()}
          />
          {photo ? (
            <Button
              variant="tertiary"
              disabled={removing}
              onClick={() =>
                startRemoving(async () => {
                  setError(null);
                  const result = await removeAircraftPhoto(aircraftId);
                  if (result.error) setError(result.error);
                  else router.refresh();
                })
              }
            >
              <Trash2 aria-hidden size={16} strokeWidth={2} />
              {removing ? 'Removing…' : 'Remove photo'}
            </Button>
          ) : null}
        </div>
        {photo ? (
          <p className="text-xs text-secondary">
            A removed or replaced photo still counts toward your storage.
          </p>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </Card>
  );
}
