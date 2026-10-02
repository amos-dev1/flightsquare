'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { CalendarPlus, Ban, X } from 'lucide-react';

import {
  bookAircraft,
  cancelReservation,
  checkBookingAgainstMaintenance,
  clearReservationFlag,
  createBlackout,
  removeBlackout,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import type {
  AircraftResponse,
  BlackoutResponse,
  BookingMaintenanceCheckResponse,
} from '@flightsquare/shared';

/** "09:00" to "12:00" as 3.0. Wall-clock subtraction, nothing more. */
function hoursBetween(from: string, to: string): number {
  const minutes = (value: string): number => {
    const [h, m] = value.split(':');
    return Number(h ?? 0) * 60 + Number(m ?? 0);
  };
  return Math.max(0, (minutes(to) - minutes(from)) / 60);
}

/**
 * Booking, in the club's own clock.
 *
 * A date and two times rather than two datetime pickers: nobody books
 * "Saturday 09:00 until Saturday 12:00", they book Saturday morning. A
 * booking that crosses midnight is rare enough to be worth the one case this
 * cannot express.
 */
export function BookingForm({
  fleet,
  defaultAircraftId,
  defaultDate,
  zoneLabel,
}: {
  fleet: AircraftResponse[];
  defaultAircraftId: string;
  defaultDate: string;
  zoneLabel: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(bookAircraft, {});

  /*
    §4.6: what this block of time would take the aeroplane past.

    The block's length is wall-clock arithmetic a browser may do; whether it
    crosses an inspection is not — that needs the meters and every rule on the
    aeroplane, which §8.2 keeps on the server. Warn only: it never stops the
    submit, and no answer is no warning.
  */
  const [aircraftId, setAircraftId] = useState(defaultAircraftId);
  const [starts, setStarts] = useState(state.values?.starts ?? '09:00');
  const [ends, setEnds] = useState(state.values?.ends ?? '12:00');
  const [crosses, setCrosses] = useState<BookingMaintenanceCheckResponse['crosses']>([]);

  const blockHours = hoursBetween(starts, ends);

  useEffect(() => {
    if (!aircraftId || blockHours <= 0) {
      setCrosses([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void checkBookingAgainstMaintenance(aircraftId, blockHours.toFixed(1)).then((result) => {
        if (current) setCrosses(result.crosses ?? []);
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [aircraftId, blockHours]);

  const registration = fleet.find((one) => one.id === aircraftId)?.registration ?? 'the aircraft';

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Aircraft" required>
            <Select
              name="aircraft_id"
              required
              value={aircraftId}
              onChange={(event) => setAircraftId(event.target.value)}
            >
              {fleet.map((aircraft) => (
                <option key={aircraft.id} value={aircraft.id}>
                  {aircraft.registration}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Date" required>
            <Input
              name="date"
              type="date"
              required
              defaultValue={state.values?.date ?? defaultDate}
            />
          </Field>

          <Field label="From" required hint={zoneLabel}>
            <Input
              name="starts"
              type="time"
              required
              step={900}
              value={starts}
              onChange={(event) => setStarts(event.target.value)}
              className="tabular"
            />
          </Field>

          <Field label="Until" required hint={zoneLabel}>
            <Input
              name="ends"
              type="time"
              required
              step={900}
              value={ends}
              onChange={(event) => setEnds(event.target.value)}
              className="tabular"
            />
          </Field>
        </div>

        <Field label="Purpose" hint="So the next person knows what the aeroplane is doing.">
          <Input
            name="purpose"
            maxLength={200}
            placeholder="Breakfast run to Truckee"
            defaultValue={state.values?.purpose}
          />
        </Field>

        <Field label="Notes">
          <Textarea name="notes" maxLength={2000} defaultValue={state.values?.notes} />
        </Field>

        {/* A warning, not a refusal: somebody may be flying it to the shop, and
            a club that cannot book the flight that fixes the aeroplane is a club
            that stops using the app. */}
        {crosses.length > 0 ? (
          <Alert tone="info">
            {`This ${blockHours.toFixed(1)} hr booking would take ${registration} past ${crosses
              .map((item) => item.name)
              .join(' and ')}. You can still book it.`}
          </Alert>
        ) : null}

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Booked. It is on the calendar below.</Alert> : null}

        <Button type="submit" disabled={pending}>
          <CalendarPlus aria-hidden size={16} strokeWidth={2} />
          {pending ? 'Booking…' : 'Book it'}
        </Button>
      </form>
    </Card>
  );
}

/** Giving a slot back. A status, never a delete — the record stays (§10). */
export function CancelBooking({ id, label }: { id: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="tertiary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await cancelReservation(id);
            if (result.error) setError(result.error);
          })
        }
      >
        <X aria-hidden size={16} strokeWidth={2} />
        {pending ? 'Cancelling…' : label}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/**
 * §3.3: a grounding flags the bookings already on the calendar rather than
 * cancelling them, because somebody has to call those members. Clearing the
 * flag is the admin saying they have.
 */
export function ClearFlag({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await clearReservationFlag(id);
            if (result.error) setError(result.error);
          })
        }
      >
        {pending ? 'Saving…' : "I've spoken to them"}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/** An admin taking the aeroplane off the calendar: annual, AOG, owner-held. */
export function BlackoutForm({
  fleet,
  defaultAircraftId,
  defaultDate,
  zoneLabel,
}: {
  fleet: AircraftResponse[];
  defaultAircraftId: string;
  defaultDate: string;
  zoneLabel: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createBlackout, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Aircraft" required>
            <Select
              name="aircraft_id"
              required
              defaultValue={state.values?.aircraft_id ?? defaultAircraftId}
            >
              {fleet.map((aircraft) => (
                <option key={aircraft.id} value={aircraft.id}>
                  {aircraft.registration}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="What for" required>
            <Input
              name="reason"
              required
              maxLength={200}
              placeholder="Annual inspection"
              defaultValue={state.values?.reason}
            />
          </Field>

          <Field label="From" required hint={zoneLabel}>
            <div className="flex gap-2">
              <Input
                name="from_date"
                type="date"
                required
                defaultValue={state.values?.from_date ?? defaultDate}
              />
              <Input
                name="from_time"
                type="time"
                step={900}
                defaultValue={state.values?.from_time ?? '00:00'}
                className="tabular"
              />
            </div>
          </Field>

          <Field label="Until" required hint={zoneLabel}>
            <div className="flex gap-2">
              <Input
                name="to_date"
                type="date"
                required
                defaultValue={state.values?.to_date ?? defaultDate}
              />
              <Input
                name="to_time"
                type="time"
                step={900}
                defaultValue={state.values?.to_time ?? '00:00'}
                className="tabular"
              />
            </div>
          </Field>
        </div>

        {/*
          §3.3 again: this refuses rather than cancelling over somebody. The
          form says so before it is submitted, because "cancel the booking
          first, and tell them why" reads better as advice than as an error.
        */}
        <p className="text-xs text-secondary">
          If a member already has those hours, this will not take them — cancel their
          booking first, and tell them why.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">The aircraft is off the calendar for that window.</Alert> : null}

        <Button type="submit" variant="secondary" disabled={pending}>
          <Ban aria-hidden size={16} strokeWidth={2} />
          {pending ? 'Saving…' : 'Block the time'}
        </Button>
      </form>
    </Card>
  );
}

export function RemoveBlackout({ blackout }: { blackout: BlackoutResponse }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="tertiary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await removeBlackout(blackout.id);
            if (result.error) setError(result.error);
          })
        }
      >
        <X aria-hidden size={16} strokeWidth={2} />
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
