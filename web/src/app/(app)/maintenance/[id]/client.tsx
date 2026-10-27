'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useState, useTransition } from 'react';
import { Archive, ClipboardCheck, RotateCcw } from 'lucide-react';

import {
  logMaintenanceCompletion,
  setMaintenanceItemStatus,
  voidMaintenanceCompletion,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { FileUpload } from '@/components/upload';
import type { MaintenanceItemResponse } from '@flightsquare/shared';
// The subpath: the package root is not resolvable by the bundler.
import { uuidv7 } from '@flightsquare/shared/uuidv7';

/**
 * Logging a completion (mockup 05).
 *
 * Prefilled with today and the aeroplane's last recorded Hobbs and tach — both
 * meters, as real values rather than placeholders, so leaving them is using
 * them. All editable: work is logged days after it was done more often than
 * not, and the meters then were not the meters now, which the hint says.
 *
 * Both are filled even though the item counts on one: the server keeps the
 * reading for the item's own meter (`hours_meter`) as the anchor, and a
 * logbook entry records both anyway.
 *
 * What it resets to is deliberately not computed here. The page reloads with
 * the item's new due points on it, and the server is the only thing that knows
 * them — §8.2, and the same reason the preview on the add form is a round trip.
 */
export function CompletionForm({
  item,
  meters,
}: {
  item: MaintenanceItemResponse;
  /** Last recorded on the aeroplane; null where it has never been read. */
  meters: { hobbs: string | null; tach: string | null };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    logMaintenanceCompletion.bind(null, item.id),
    {},
  );

  const today = new Date().toISOString().slice(0, 10);

  /*
    One uuid, minted once per mounted form, used as the completion's id and as
    its idempotency key.

    The id is what lets an invoice name the completion; the key is what stops a
    retry after a dropped connection logging the work twice and rolling an
    annual forward twice. Held in state rather than regenerated on render, so a
    validation error and a resubmit are the same request.
  */
  // uuidv7 rather than `crypto.randomUUID`, which browsers only provide on a
  // secure origin: opened over plain http on the LAN, this page threw on load.
  const [completionId] = useState(() => uuidv7());
  const saved = state.values?.completion_id;

  return (
    <Card className="px-5 py-4">
      <details className="group" open={Boolean(state.error)}>
        <summary className="inline-flex h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-subtle">
          <ClipboardCheck aria-hidden size={16} strokeWidth={2} />
          Mark complete
        </summary>

        <form action={action} className="mt-3 space-y-4 border-t border-line pt-4">
          <input type="hidden" name="completion_id" value={completionId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date done" required>
              <Input
                name="done_on"
                type="date"
                required
                max={today}
                defaultValue={state.values?.done_on ?? today}
              />
            </Field>
            <Field
              label="Next interval starts from"
              hint="Previous due point keeps the schedule on its original dates."
            >
              <Select name="next_from" defaultValue={item.next_from}>
                <option value="completion">This completion</option>
                <option value="previous_due">Previous due point</option>
              </Select>
            </Field>
          </div>

          {/*
            Named explicitly, both of them. §11 and §3.4: Hobbs and tach run at
            different rates by design, and an interval anchored to the wrong one
            is a wrong number for the next year.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Tach reading"
              hint={meters.tach ? `Last recorded ${meters.tach}. Change it if the work was done at a different reading.` : undefined}
            >
              <Input
                name="tach"
                inputMode="decimal"
                className="tabular"
                defaultValue={state.values?.tach ?? meters.tach ?? ''}
              />
            </Field>
            <Field
              label="Hobbs reading"
              hint={meters.hobbs ? `Last recorded ${meters.hobbs}. Change it if the work was done at a different reading.` : undefined}
            >
              <Input
                name="hobbs"
                inputMode="decimal"
                className="tabular"
                defaultValue={state.values?.hobbs ?? meters.hobbs ?? ''}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Performed by">
              <Input
                name="performed_by"
                maxLength={200}
                placeholder="Shop or mechanic"
                defaultValue={state.values?.performed_by}
              />
            </Field>
            <Field label="A&P / IA certificate">
              <Input name="cert_no" maxLength={100} defaultValue={state.values?.cert_no} />
            </Field>
          </div>

          <Field label="Logbook entry" hint="What was done, in the words the logbook uses.">
            <Textarea name="notes" rows={3} defaultValue={state.values?.notes} />
          </Field>

          {/*
            §3.6: append-only, and the form says so before it is submitted
            rather than after. A completion can be voided with a reason; it
            cannot be edited away.
          */}
          <p className="text-xs text-secondary">
            Completions cannot be edited once saved. A correction is a void with a reason, plus a
            new record.
          </p>

          {state.error ? <Alert>{state.error}</Alert> : null}

          {saved ? (
            <div className="space-y-3 rounded-xl border border-line bg-subtle px-4 py-3">
              <p className="text-sm">
                Logged. The due points above have moved on. Attach the invoice or the logbook entry
                now, or leave it — the completion stands either way.
              </p>
              {/*
                Mockup 05's two tiles, as two controls: these are *kinds*, and
                where the file comes from is the browser's question. Both accept
                a photograph or a PDF, because a shop emails one and a club
                photographs the other.
              */}
              <div className="flex flex-wrap gap-3">
                <FileUpload
                  owner={{ kind: 'completion', id: saved }}
                  label="Attach invoice"
                  fileKind="invoice"
                  revalidate={`/maintenance/${item.id}`}
                />
                <FileUpload
                  owner={{ kind: 'completion', id: saved }}
                  label="Attach logbook entry"
                  fileKind="logbook_entry"
                  revalidate={`/maintenance/${item.id}`}
                />
              </div>
            </div>
          ) : (
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save and reset counter'}
            </Button>
          )}
        </form>
      </details>
    </Card>
  );
}

/** §4.7: taking one back. The reason is required and stays on the record. */
export function VoidButton({
  itemId,
  recordId,
  on,
}: {
  itemId: string;
  recordId: string;
  on: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Void
      </Button>
    );
  }

  return (
    <div className="w-full space-y-3 border-t border-line pt-3 sm:w-auto sm:border-0 sm:pt-0">
      <Field label={`Why the ${on} completion is being voided`} required>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Logged against the wrong aircraft"
          maxLength={500}
        />
      </Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await voidMaintenanceCompletion(itemId, recordId, reason);
              if (result.error) setError(result.error);
              else setOpen(false);
            })
          }
        >
          {pending ? 'Voiding…' : 'Void completion'}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * Archiving, which is the only "delete" this product has (§5.5, decision on
 * `deleted_at`). The item keeps its history and comes back on request.
 */
export function ArchiveItemButton({
  itemId,
  status,
  afterRemove,
}: {
  itemId: string;
  status: MaintenanceItemResponse['status'];
  /** Where to go once it is removed — from the edit page, the item is gone. */
  afterRemove?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const archiving = status === 'active';

  return (
    <div className="space-y-2 border-t border-line pt-6">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            if (
              archiving &&
              !window.confirm(
                'Remove this item? It stops counting down and leaves the list. Every completion already logged is kept, and it can be brought back.',
              )
            ) {
              return;
            }
            setError(null);
            const result = await setMaintenanceItemStatus(
              itemId,
              archiving ? 'archived' : 'active',
            );
            if (result.error) setError(result.error);
            else if (archiving && afterRemove) router.push(afterRemove);
          })
        }
      >
        {archiving ? (
          <Archive aria-hidden size={16} strokeWidth={2} />
        ) : (
          <RotateCcw aria-hidden size={16} strokeWidth={2} />
        )}
        {pending ? 'Saving…' : archiving ? 'Remove this item' : 'Track it again'}
      </Button>
      <p className="text-xs text-secondary">
        {archiving
          ? 'It keeps every completion already logged, stops counting down, and can be brought back.'
          : 'It starts counting down again from the last completion on record.'}
      </p>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
