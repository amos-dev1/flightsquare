'use client';

import { useActionState, useState, useTransition } from 'react';
import { Plus } from 'lucide-react';

import {
  createAircraftDocument,
  updateAircraftDocument,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';
import { FileUpload } from '@/components/upload';
import type { AircraftDocumentKind } from '@flightsquare/shared';

/** Which kinds have a date to count down to. The rest are not asked. */
const EXPIRES: Record<AircraftDocumentKind, boolean> = {
  airworthiness: false,
  registration: true,
  operating_limitations: false,
  weight_balance: false,
  insurance: true,
  other: true,
};

/**
 * Filing a document, and then its file.
 *
 * Two steps on purpose rather than one combined form. The document row carries
 * the dates and is written first — which is the order the schema enforces, and
 * which makes "the insurance expires on 31 March and nobody has scanned it yet"
 * an expressible state rather than a thing a club has to remember separately.
 *
 * The expiry field is only asked for where there is one. A standard
 * airworthiness certificate is good for as long as the aeroplane is maintained
 * and a weight and balance sheet until it is modified; putting an empty date box
 * in front of somebody is how a guess ends up on the record.
 */
export function DocumentForm({
  aircraftId,
  kind,
}: {
  aircraftId: string;
  kind: AircraftDocumentKind;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    createAircraftDocument.bind(null, aircraftId),
    {},
  );

  const documentId = state.values?.document_id;

  return (
    <details className="group">
      <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-subtle">
        <Plus aria-hidden size={16} strokeWidth={2} />
        Add
      </summary>

      <form action={action} className="mt-3 space-y-4 border-t border-line pt-4">
        <input type="hidden" name="kind" value={kind} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" required hint="What it is, so a renewal can be told from the one before.">
            <Input name="title" required maxLength={200} defaultValue={state.values?.title} />
          </Field>
          <Field label="Reference" hint="Policy or certificate number. Not parsed.">
            <Input
              name="reference"
              maxLength={100}
              className="tabular"
              defaultValue={state.values?.reference}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Issued">
            <Input name="issued_on" type="date" defaultValue={state.values?.issued_on} />
          </Field>
          {EXPIRES[kind] ? (
            <Field label="Expires" hint="A reminder goes out 60 days before. It never grounds the aircraft.">
              <Input name="expires_on" type="date" defaultValue={state.values?.expires_on} />
            </Field>
          ) : (
            <p className="self-end text-sm text-secondary">
              This one does not expire, so there is no date to ask for.
            </p>
          )}
        </div>

        <Field label="Notes">
          <Textarea name="notes" rows={2} maxLength={2000} defaultValue={state.values?.notes} />
        </Field>

        {state.error ? <Alert>{state.error}</Alert> : null}

        {documentId ? (
          <div className="space-y-3 rounded-xl border border-line bg-subtle px-4 py-3">
            <p className="text-sm">
              Recorded. Attach the scan or photograph now, or leave it and add one later.
            </p>
            <FileUpload
              owner={{ kind: 'document', id: documentId }}
              label="Attach the file"
              fileKind="document"
              revalidate={`/aircraft/${aircraftId}/documents`}
            />
          </div>
        ) : (
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save document'}
          </Button>
        )}
      </form>
    </details>
  );
}

/**
 * Taking a document off the list.
 *
 * There is no delete (§10). A document filed by mistake is removed with a
 * reason and stays on the page under its own heading; a superseded certificate
 * is not removed at all, because the one that was current last March is what
 * answers a question about last March.
 */
export function RemoveDocument({
  documentId,
  aircraftId,
}: {
  documentId: string;
  aircraftId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-semibold underline decoration-1 underline-offset-4"
      >
        Remove
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <Field label="Why it is being removed" required>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Filed against the wrong aircraft"
          maxLength={500}
        />
      </Field>
      <p className="text-xs text-secondary">
        It stays on file, marked removed. The bytes still count toward your storage until they are
        purged.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              if (reason.trim().length < 5) {
                setError('Say why in a few words. This stays on the record.');
                return;
              }
              const result = await updateAircraftDocument(documentId, aircraftId, {
                status: 'removed',
                removed_reason: reason.trim(),
              });
              if (result.error) setError(result.error);
              else setOpen(false);
            })
          }
        >
          {pending ? 'Removing…' : 'Remove it'}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
