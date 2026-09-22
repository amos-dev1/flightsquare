'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { Check, PauseCircle, Undo2 } from 'lucide-react';

import {
  deferSquawk,
  fileSquawk,
  reopenSquawk,
  resolveSquawk,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import type { AircraftResponse, SquawkResponse } from '@flightsquare/shared';
// A value import, and from the subpath — see the note in log-flight/form.tsx.
// `crypto.randomUUID` is secure-context-only and absent when this app is
// served over plain HTTP from a LAN address, which is how a phone reaches it.
import { uuidv7 } from '@flightsquare/shared/uuidv7';

/**
 * Filing one. `squawks: write`, which every pilot holds — §1.5 keeps this a
 * separate resource from `maintenance` precisely so that reporting a defect
 * and signing off the work are different permissions held by different
 * people.
 */
export function SquawkForm({ fleet }: { fleet: AircraftResponse[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(fileSquawk, {});

  /**
   * §8.2: one key per *submission attempt*, so a retry after a dropped
   * connection files the squawk once rather than twice — and so a second,
   * different squawk is not mistaken for a retry of the first.
   *
   * A key fixed for the life of the component gets both wrong: the form is
   * never remounted (filing does not navigate), so squawk two reuses squawk
   * one's key. A different body is refused as a conflict, and an identical
   * one is silently replayed and never written at all.
   */
  const [key, setKey] = useState(() => uuidv7());

  useEffect(() => {
    // A submission that came back clean is spent; the next one is new work.
    if (!pending && state.saved) setKey(uuidv7());
  }, [pending, state.saved]);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="idempotency_key" value={key} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Aircraft" required>
            <Select
              name="aircraft_id"
              required
              defaultValue={state.values?.aircraft_id ?? fleet[0]?.id}
            >
              {fleet.map((aircraft) => (
                <option key={aircraft.id} value={aircraft.id}>
                  {aircraft.registration}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Severity"
            hint="Grounding stops the aircraft being booked until it is resolved or deferred."
          >
            <Select name="severity" defaultValue={state.values?.severity ?? 'minor'}>
              <option value="advisory">Advisory — worth knowing</option>
              <option value="minor">Minor — airworthy, needs attention</option>
              <option value="major">Major — get it looked at</option>
              <option value="grounding">Grounding — do not fly</option>
            </Select>
          </Field>
        </div>

        <Field label="What is wrong" required>
          <Input
            name="summary"
            required
            maxLength={200}
            placeholder="Left brake soft"
            defaultValue={state.values?.summary}
          />
        </Field>

        <Field label="Details" hint="What you saw, heard or felt — as much as is useful.">
          <Textarea
            name="details"
            maxLength={4000}
            defaultValue={state.values?.details}
            placeholder="Pedal travels most of the way before it bites."
          />
        </Field>

        {/*
          §3.6, said before it is submitted rather than after: the squawk log
          is one of the records read back after an accident, so what gets
          written here is not something anyone edits later.
        */}
        <p className="text-xs text-secondary">
          What you report here stays as written. Anything further goes in a new squawk.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? (
          <Alert tone="info">
            Filed. It is on the outstanding list below, and on the aircraft.
          </Alert>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Filing…' : 'File squawk'}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Closing one, or deciding it may be flown with.
 *
 * Both need `maintenance: write`. The page hides these for a pilot, and the
 * API refuses them regardless — hiding a button is cosmetics (§8.1).
 */
export function SquawkActions({ squawk }: { squawk: SquawkResponse }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [state, action, deferring] = useActionState<FormState, FormData>(
    deferSquawk.bind(null, squawk.id),
    {},
  );

  /** Run one of the button actions and show whatever it says went wrong. */
  const run = (work: () => Promise<{ error?: string }>) => () =>
    startTransition(async () => {
      setError(null);
      const result = await work();
      if (result.error) setError(result.error);
    });

  if (squawk.status === 'resolved') {
    return (
      <div className="space-y-2">
        <Button variant="tertiary" disabled={pending} onClick={run(() => reopenSquawk(squawk.id))}>
          <Undo2 aria-hidden size={16} strokeWidth={2} />
          Reopen
        </Button>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {error ? (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <Button disabled={pending} onClick={run(() => resolveSquawk(squawk.id, ''))}>
        <Check aria-hidden size={16} strokeWidth={2} />
        {pending ? 'Saving…' : 'Mark resolved'}
      </Button>

      {squawk.status === 'open' ? (
        <details className="w-full">
          <summary className="inline-flex h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-subtle">
            <PauseCircle aria-hidden size={16} strokeWidth={2} />
            Defer
          </summary>

          <form action={action} className="mt-3 space-y-4 border-t border-line pt-4">
            {/*
              A deferral is the decision that the aircraft may fly with a
              known defect — what an MEL and 14 CFR 91.213 are for. It clears
              the grounding and is recorded as its own row, permanently.
            */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Basis" required>
                <Select name="basis" defaultValue="far_91_213">
                  <option value="far_91_213">14 CFR 91.213</option>
                  <option value="mel">MEL</option>
                  <option value="cdl">CDL</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Reference" hint="MEL item number, if there is one.">
                <Input name="reference" maxLength={100} />
              </Field>
              <Field label="Deferred until">
                <Input name="expires_on" type="date" />
              </Field>
            </div>

            <Field label="Note" hint="Why this is safe to defer, and what was placarded.">
              <Input name="note" maxLength={2000} />
            </Field>

            <p className="text-xs text-secondary">
              Deferring lets the aircraft be booked again. The record of it is permanent.
            </p>

            {state.error ? <Alert>{state.error}</Alert> : null}

            <Button type="submit" variant="secondary" disabled={deferring}>
              {deferring ? 'Saving…' : 'Defer squawk'}
            </Button>
          </form>
        </details>
      ) : (
        <Button variant="secondary" disabled={pending} onClick={run(() => reopenSquawk(squawk.id))}>
          <Undo2 aria-hidden size={16} strokeWidth={2} />
          Lift deferral
        </Button>
      )}
    </div>
  );
}
