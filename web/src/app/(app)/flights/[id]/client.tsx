'use client';

import { Ban, PencilLine } from 'lucide-react';
import { useActionState, useState, useTransition } from 'react';

import { logFlight, markLoggedInError, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, SectionHeading, Textarea } from '@/components/ui';
import type { AircraftResponse, FlightResponse } from '@flightsquare/shared';
import { uuidv7 } from '@flightsquare/shared/uuidv7';

/**
 * Correcting a flight, which is not editing one.
 *
 * §3.4 makes the meters append-only, so what this files is a **new flight**
 * carrying `supersedes_id` — the whole entry again, with the figures fixed.
 * Both rows stay. That is also why the form is the whole flight rather than
 * the one field being changed: a correction replaces an entry, and an entry
 * with half its fields missing is not one.
 *
 * Behind a button, following `ReverseCharge` and `VoidButton`: a consequential
 * action is one deliberate click past the routine ones, and the permanence is
 * said in prose above the button rather than in a dialog after it.
 */
export function CorrectFlight({
  flight,
  aircraft,
}: {
  flight: FlightResponse;
  aircraft: AircraftResponse;
}) {
  const [open, setOpen] = useState<'correct' | 'error' | null>(null);

  if (!flight.correctable) {
    /*
      Say what, not just no. The rule is "your own flight, while nothing has
      been flown on that aeroplane since" — and once somebody else has flown
      it, their Hobbs start was read against this flight's end, so moving it
      now moves a figure they have already built on. §11: name a role, never
      a permission string.
    */
    return (
      <Card className="px-5 py-4 text-sm text-secondary">
        This entry can no longer be changed here. {aircraft.registration} has been flown since,
        or the flight is somebody else&rsquo;s — an administrator can still correct it.
      </Card>
    );
  }

  if (open === null) {
    return (
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setOpen('correct')}>
          <PencilLine aria-hidden size={16} strokeWidth={2} />
          Correct this entry
        </Button>
        <Button variant="tertiary" onClick={() => setOpen('error')}>
          <Ban aria-hidden size={16} strokeWidth={2} />
          It didn&rsquo;t happen
        </Button>
      </div>
    );
  }

  return open === 'correct' ? (
    <CorrectionForm flight={flight} aircraft={aircraft} onCancel={() => setOpen(null)} />
  ) : (
    <LoggedInError flight={flight} onCancel={() => setOpen(null)} />
  );
}

function CorrectionForm({
  flight,
  aircraft,
  onCancel,
}: {
  flight: FlightResponse;
  aircraft: AircraftResponse;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    logFlight.bind(null, flight.aircraft_id),
    {},
  );
  // One key per attempt, as everywhere else (§8.2). A correction is a write
  // that moves meters and money, so a dropped connection must not file two.
  const [idempotencyKey] = useState(() => uuidv7());

  const unit = aircraft.fuel_units === 'litres' ? 'litres' : 'gallons';
  const was = (key: string, fallback: string | null) => state.values?.[key] ?? fallback ?? '';

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="supersedes_id" value={flight.id} />
      {/* No squawks on a correction: the defect belongs to the flight it was
          found on, and filing it again would file it twice (§3.6). */}
      <input type="hidden" name="squawk_count" value="0" />

      <SectionHeading>Correct this entry</SectionHeading>

      <Card className="space-y-4 p-5 sm:p-6">
        <Field
          label="What was wrong with it?"
          required
          hint="The original entry stays on the log beside the correction. Both do, permanently — nothing in a flight record is ever removed."
        >
          <Input
            name="correction_reason"
            required
            minLength={5}
            maxLength={500}
            autoFocus
            placeholder="Hobbs was misread; the panel said 1202.5"
          />
        </Field>
      </Card>

      <Card className="space-y-4 p-5 sm:p-6">
        <Field label="Date" required>
          <Input type="date" name="flight_date" required defaultValue={was('flight_date', flight.flight_date)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From">
            <Input
              name="departed_from"
              className="uppercase"
              autoCapitalize="characters"
              defaultValue={was('departed_from', flight.departed_from)}
            />
          </Field>
          <Field label="To">
            <Input
              name="arrived_at"
              className="uppercase"
              autoCapitalize="characters"
              defaultValue={was('arrived_at', flight.arrived_at)}
            />
          </Field>
        </div>
      </Card>

      {/* §11: Hobbs and tach named explicitly, neither derived from the other. */}
      <Card className="space-y-4 p-5 sm:p-6">
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">Hobbs</legend>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Out">
              <Input name="hobbs_start" inputMode="decimal" className="tabular" defaultValue={was('hobbs_start', flight.hobbs_start)} />
            </Field>
            <Field label="In">
              <Input name="hobbs_end" inputMode="decimal" className="tabular" defaultValue={was('hobbs_end', flight.hobbs_end)} />
            </Field>
          </div>
        </fieldset>
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">Tach</legend>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Out">
              <Input name="tach_start" inputMode="decimal" className="tabular" defaultValue={was('tach_start', flight.tach_start)} />
            </Field>
            <Field label="In">
              <Input name="tach_end" inputMode="decimal" className="tabular" defaultValue={was('tach_end', flight.tach_end)} />
            </Field>
          </div>
        </fieldset>
        <p className="text-xs text-secondary">
          The meters are worked out again from what you enter, and the maintenance countdowns
          move with them.
        </p>
      </Card>

      <Card className={`space-y-4 p-5 sm:p-6`}>
        <p className="text-base font-semibold">Fuel · {unit}</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Before">
            <Input name="fuel_remaining_before" inputMode="decimal" className="tabular" defaultValue={was('fuel_remaining_before', flight.fuel_remaining_before)} />
          </Field>
          <Field label="After">
            <Input name="fuel_remaining_after" inputMode="decimal" className="tabular" defaultValue={was('fuel_remaining_after', flight.fuel_remaining_after)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Added">
            <Input name="fuel_added_qty" inputMode="decimal" className="tabular" defaultValue={was('fuel_added_qty', flight.fuel_added_qty)} />
          </Field>
          <Field label="Cost" hint="USD, e.g. 204.10">
            <Input
              name="fuel_added_cost"
              inputMode="decimal"
              className="tabular"
              defaultValue={
                state.values?.fuel_added_cost ??
                (flight.fuel_added_cost_cents !== null
                  ? (flight.fuel_added_cost_cents / 100).toFixed(2)
                  : '')
              }
            />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5 sm:p-6">
        <label className="block">
          <span className="mb-2 block text-sm font-semibold">Notes</span>
          <Textarea name="remarks" maxLength={2000} defaultValue={was('remarks', flight.remarks)} />
        </label>
      </Card>

      {state.error ? <Alert>{state.error}</Alert> : null}

      {/*
        §3.7 rule 2, said before it is submitted rather than after: the charge
        is not rewritten, it is reversed and worked out again, and the
        statement carries both halves.
      */}
      <p className="text-xs text-secondary">
        Any charge on this flight is reversed and a new one worked out. Both halves stay on the
        statement.
      </p>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save the correction'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Leave it as it is
        </Button>
      </div>
    </form>
  );
}

/** The one thing a correction cannot say by replacing numbers. */
function LoggedInError({ flight, onCancel }: { flight: FlightResponse; onCancel: () => void }) {
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <Field
        label="Why is this entry being taken back?"
        required
        hint="It stays on the log, marked. The aeroplane's meters go back to the reading before it, and any charge is reversed."
      >
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          autoFocus
          placeholder="Entered twice from the phone"
        />
      </Field>

      {error ? <Alert>{error}</Alert> : null}

      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          disabled={pending || !reason.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await markLoggedInError(flight, reason);
              if (result.error) setError(result.error);
              else onCancel();
            })
          }
        >
          {pending ? 'Saving…' : 'It didn’t happen'}
        </Button>
        <Button type="button" variant="tertiary" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
