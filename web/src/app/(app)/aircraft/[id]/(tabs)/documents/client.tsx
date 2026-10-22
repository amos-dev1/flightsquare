'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import {
  createAircraftDocument,
  updateAircraftDocument,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { uploadFile } from '@/components/upload';
import type { AircraftDocumentKind } from '@flightsquare/shared';

import { DOCUMENT_TYPES } from './types';

/** What the browser offers to pick — what the API accepts for a document. */
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic,image/webp';

/**
 * Adding a document: what it is, when it expires if it does, and the file.
 *
 * One form, where it used to be one per type plus a second step for the file.
 * The type is a choice from the list; "Other" asks for a name, and every other
 * type is named by its type, so a title is never typed twice.
 *
 * The file is required here, because a document with nothing to open is
 * something a pilot cannot use. It still travels in the order the schema wants
 * (§3.8): the action saves the document and hands back its id, and the browser
 * sends the file straight to storage against it — the bytes never pass through
 * the Next server. If the upload fails, the document is already saved and the
 * form says so, rather than pretending nothing happened.
 *
 * The expiry date is offered for every type and required for none: a standard
 * airworthiness certificate never expires, but a special one, a registration
 * and a policy do, and whoever files it knows which this is.
 */
export function DocumentForm({ aircraftId }: { aircraftId: string }) {
  const [open, setOpen] = useState(false);
  // A fresh form for each document: the last one's saved state must not be
  // what the next one opens on.
  const [round, setRound] = useState(0);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus aria-hidden size={16} strokeWidth={2} />
        Add document
      </Button>
    );
  }

  return (
    <AddDocument
      key={round}
      aircraftId={aircraftId}
      onClose={() => {
        setRound((n) => n + 1);
        setOpen(false);
      }}
    />
  );
}

function AddDocument({ aircraftId, onClose }: { aircraftId: string; onClose: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<AircraftDocumentKind | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(
    createAircraftDocument.bind(null, aircraftId),
    {},
  );

  const documentId = state.saved ? state.values?.document_id : undefined;
  const noun = DOCUMENT_TYPES.find((type) => type.kind === kind)?.noun ?? '';

  async function sendFile() {
    if (!documentId || !file) return;
    setSending(true);
    setSendError(null);
    const result = await uploadFile({ kind: 'document', id: documentId }, file, {
      fileKind: 'document',
      revalidate: `/aircraft/${aircraftId}/documents`,
    });
    setSending(false);
    if (result.error) {
      setSendError(result.error);
      return;
    }
    // Done: close, and the next one starts on a clean form.
    router.refresh();
    onClose();
  }

  // The document is saved: send its file, once.
  useEffect(() => {
    if (documentId) void sendFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-line bg-surface p-5"
      onSubmit={(event) => {
        if (!file) {
          event.preventDefault();
          setFileError('Choose the PDF or photo of the document.');
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required>
          <Select
            name="kind"
            required
            value={kind}
            onChange={(event) => setKind(event.target.value as AircraftDocumentKind)}
          >
            <option value="" disabled>
              Choose a type
            </option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type.kind} value={type.kind}>
                {type.noun}
              </option>
            ))}
          </Select>
        </Field>

        {/* Named by its type, unless it is "Other" — then it needs a name. */}
        {kind === 'other' ? (
          <Field label="Document name" required>
            <Input
              name="title"
              required
              maxLength={200}
              placeholder="e.g. 337 for the GPS install"
              defaultValue={state.values?.title}
            />
          </Field>
        ) : (
          <input type="hidden" name="title" value={noun} />
        )}

        <Field
          label="Expires"
          hint="Optional. Leave it empty if this one does not expire. It never affects bookings."
        >
          <Input name="expires_on" type="date" defaultValue={state.values?.expires_on} />
        </Field>

        <Field label="File" required hint="A PDF or a photo.">
          <input
            type="file"
            accept={ACCEPT}
            aria-invalid={fileError ? true : undefined}
            disabled={Boolean(documentId)}
            className="block w-full text-sm text-secondary file:mr-3 file:h-11 file:rounded-lg file:border file:border-control file:bg-surface file:px-4 file:text-sm file:font-semibold file:text-navy hover:file:bg-subtle"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setFileError(null);
            }}
          />
        </Field>
      </div>

      {fileError ? <Alert>{fileError}</Alert> : null}
      {state.error ? <Alert>{state.error}</Alert> : null}

      {sendError ? (
        <div className="space-y-3">
          <Alert>
            The document is saved, but its file did not upload: {sendError}
          </Alert>
          <Button type="button" onClick={() => void sendFile()}>
            Try the upload again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending || sending || Boolean(documentId)}>
            {pending ? 'Saving…' : sending ? 'Uploading…' : 'Save document'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || sending}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      )}
    </form>
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
        className="inline-flex min-h-11 items-center text-sm font-semibold underline decoration-1 underline-offset-4"
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
