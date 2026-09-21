'use client';

import { useActionState, useState, useTransition } from 'react';
import { Undo2 } from 'lucide-react';

import { recordAdjustment, reverseCharge, setRate, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { AircraftResponse, MemberResponse, RateResponse } from '@flightsquare/shared';

/**
 * Setting a rate — which is writing a new row, not editing one (§3.7 rule 4).
 *
 * The form says so, because somebody who thinks they are correcting a typo
 * should know they are recording a change with a date on it, and that what
 * has already been charged will not move.
 */
export function RateForm({
  fleet,
  members,
}: {
  fleet: AircraftResponse[];
  members: MemberResponse[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(setRate, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
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

          <Field label="Hourly rate" required hint="What it costs per billed hour.">
            <Input
              name="amount"
              required
              inputMode="decimal"
              placeholder="165.00"
              className="tabular"
              defaultValue={state.values?.amount}
            />
          </Field>

          <Field
            label="Applies to"
            hint="Everyone, or one member on this aircraft (§3.7's first layer)."
          >
            <Select name="membership_id" defaultValue={state.values?.membership_id ?? ''}>
              <option value="">The whole club</option>
              {members
                .filter((member) => member.status === 'active')
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ?? member.email}
                  </option>
                ))}
            </Select>
          </Field>

          <Field label="From" hint="Defaults to today. Flights before it keep their price.">
            <Input
              name="effective_from"
              type="date"
              defaultValue={state.values?.effective_from}
            />
          </Field>
        </div>

        <p className="text-xs text-secondary">
          A rate change is a new entry, not an edit. Everything already charged keeps the
          rate it was charged at.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Recorded.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Set the rate'}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The only hand-written line in the ledger, and in v1 the whole of how money
 * moving is recorded.
 *
 * The direction is chosen in words. A minus sign somebody has to remember to
 * type is a mistake with money in it.
 */
export function AdjustmentForm({ members }: { members: MemberResponse[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(recordAdjustment, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Member" required>
            <Select
              name="membership_id"
              required
              defaultValue={state.values?.membership_id ?? members[0]?.id}
            >
              {members
                .filter((member) => member.status === 'active')
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ?? member.email}
                  </option>
                ))}
            </Select>
          </Field>

          <Field label="What happened" required>
            <Select name="kind" defaultValue={state.values?.kind ?? 'payment'}>
              <option value="payment">They paid us</option>
              <option value="charge">They owe us more</option>
            </Select>
          </Field>

          <Field label="Amount" required>
            <Input
              name="amount"
              required
              inputMode="decimal"
              placeholder="400.00"
              className="tabular"
              defaultValue={state.values?.amount}
            />
          </Field>
        </div>

        <Field label="What it was" required hint="Cheque number, date, whatever you will want later.">
          <Input
            name="reason"
            required
            maxLength={500}
            placeholder="Paid $400 by cheque, 3 March"
            defaultValue={state.values?.reason}
          />
        </Field>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">On the ledger.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record it'}
        </Button>
      </form>
    </Card>
  );
}

/** §3.7 rule 2, as a control: a reversal with a reason, never an edit. */
export function ReverseCharge({ id, amountCents }: { id: string; amountCents: number }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="tertiary" onClick={() => setOpen(true)}>
        <Undo2 aria-hidden size={16} strokeWidth={2} />
        Reverse
      </Button>
    );
  }

  return (
    <div className="w-full space-y-3 border-t border-line pt-3">
      <Field
        label={`Why is ${formatMoney(amountCents)} being reversed?`}
        required
        hint="This stays on the statement beside the original. Both halves do."
      >
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          autoFocus
          placeholder="Hobbs was misread; corrected from the tach"
        />
      </Field>

      {error ? <Alert>{error}</Alert> : null}

      <div className="flex gap-3">
        <Button
          disabled={pending || !reason.trim()}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await reverseCharge(id, reason);
              if (result.error) setError(result.error);
              else setOpen(false);
            })
          }
        >
          {pending ? 'Saving…' : 'Reverse it'}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
