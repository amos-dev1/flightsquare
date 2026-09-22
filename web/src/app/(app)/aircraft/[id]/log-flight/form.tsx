'use client';

import { ChevronDown, Fuel, Info, MapPin } from 'lucide-react';
import { useActionState, useState } from 'react';

import { logFlight, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Textarea } from '@/components/ui';
import type { AircraftResponse } from '@flightsquare/shared';
// The subpath, not the root. `@flightsquare/shared` has no build step and its
// index re-exports with `./client.js` specifiers — correct for Node ESM,
// unresolvable for the bundler, which gets an empty module and fails at
// build. `uuidv7.ts` imports nothing, so it resolves everywhere.
import { uuidv7 } from '@flightsquare/shared/uuidv7';

/**
 * Display-only arithmetic.
 *
 * §8.2: the client never computes anything that matters. This is feedback
 * while typing — the stored hours are a generated column on the server, and
 * nothing here is ever sent.
 */
function hoursBetween(start: string, end: string): string | null {
  if (!start || !end) return null;
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from).toFixed(1);
}

const today = () => new Date().toISOString().slice(0, 10);

export function LogFlightForm({ aircraft }: { aircraft: AircraftResponse }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    logFlight.bind(null, aircraft.id),
    {},
  );

  /**
   * One key per form instance, so a retry after a dropped connection replays
   * rather than logging the flight a second time (§8.2).
   *
   * `uuidv7()` rather than `crypto.randomUUID()`, for two reasons and the
   * second is the one that bit. §6 chose v7 for its ordering and §8.2 says
   * the client generates ids — so the web minting v4 while the phone minted
   * v7 was already an inconsistency. And `randomUUID` exists **only in a
   * secure context**: it is there on localhost and over HTTPS, and simply
   * absent on `http://192.168.4.156`, which is exactly where this app is
   * served when it is being tested from a phone on the same Wi-Fi. The page
   * threw before it rendered. `getRandomValues`, which uuidv7 uses, has no
   * such restriction.
   */
  const [idempotencyKey] = useState(() => uuidv7());

  const [meters, setMeters] = useState({
    // Prefilled from what the aircraft is showing: the pilot confirms these
    // rather than reading them off the panel again.
    hobbs_start: state.values?.hobbs_start ?? aircraft.hobbs ?? '',
    hobbs_end: state.values?.hobbs_end ?? '',
    tach_start: state.values?.tach_start ?? aircraft.tach ?? '',
    tach_end: state.values?.tach_end ?? '',
  });

  const [showFuel, setShowFuel] = useState(Boolean(state.values?.fuel_remaining_after));
  const [showDetails, setShowDetails] = useState(Boolean(state.values?.remarks));

  const set = (key: keyof typeof meters) => (event: { target: { value: string } }) =>
    setMeters((current) => ({ ...current, [key]: event.target.value }));

  const hobbsHours = hoursBetween(meters.hobbs_start, meters.hobbs_end);
  const tachHours = hoursBetween(meters.tach_start, meters.tach_end);

  // §8.2: a start that does not meet the last reading is flagged, never
  // rejected — so say so here rather than letting it look like an error.
  const hobbsGap =
    aircraft.hobbs !== null &&
    meters.hobbs_start !== '' &&
    Number(meters.hobbs_start) !== Number(aircraft.hobbs);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />

      <Card className="space-y-6 p-5 sm:p-6">
        <Field label="Date" required>
          <Input
            name="flight_date"
            type="date"
            required
            defaultValue={state.values?.flight_date || today()}
          />
        </Field>

        {/*
          §11: Hobbs and tach are distinguished explicitly. They run at
          different rates by design, and the difference between them is real
          data about how the aircraft was flown — so neither is derived from
          the other and neither is labelled by position alone.
        */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">Hobbs</legend>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Out">
              <Input
                name="hobbs_start"
                inputMode="decimal"
                className="tabular"
                value={meters.hobbs_start}
                onChange={set('hobbs_start')}
              />
            </Field>
            <Field label="In">
              <Input
                name="hobbs_end"
                inputMode="decimal"
                className="tabular"
                autoFocus
                value={meters.hobbs_end}
                onChange={set('hobbs_end')}
              />
            </Field>
          </div>
          {hobbsHours ? (
            <p className="text-sm text-secondary">
              <span className="tabular font-semibold text-brand-black">{hobbsHours}</span> Hobbs
              hours
            </p>
          ) : null}
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">Tach</legend>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Out">
              <Input
                name="tach_start"
                inputMode="decimal"
                className="tabular"
                value={meters.tach_start}
                onChange={set('tach_start')}
              />
            </Field>
            <Field label="In">
              <Input
                name="tach_end"
                inputMode="decimal"
                className="tabular"
                value={meters.tach_end}
                onChange={set('tach_end')}
              />
            </Field>
          </div>
          {tachHours ? (
            <p className="text-sm text-secondary">
              <span className="tabular font-semibold text-brand-black">{tachHours}</span> tach
              hours
            </p>
          ) : null}
        </fieldset>

        {hobbsGap ? (
          <Alert tone="info">
            This does not match the last recorded Hobbs of{' '}
            <span className="tabular font-semibold">{aircraft.hobbs}</span>. Log it anyway — the
            flight will be flagged for review so an admin can look at the gap.
          </Alert>
        ) : null}
      </Card>

      {/* Fuel, behind one tap: most flights do not buy any. */}
      <Card className="p-5 sm:p-6">
        {showFuel ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-base font-semibold">
              <Fuel aria-hidden size={20} strokeWidth={1.75} />
              Fuel
            </p>

            <Field
              label="Remaining at shutdown"
              hint="What the next pilot is walking out to. Not a running total."
            >
              <Input
                name="fuel_remaining_after"
                inputMode="decimal"
                className="tabular"
                defaultValue={state.values?.fuel_remaining_after}
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Added" hint="Gallons">
                <Input
                  name="fuel_added_qty"
                  inputMode="decimal"
                  className="tabular"
                  defaultValue={state.values?.fuel_added_qty}
                />
              </Field>
              <Field label="Cost" hint="USD, e.g. 204.10">
                <Input
                  name="fuel_added_cost"
                  inputMode="decimal"
                  className="tabular"
                  defaultValue={state.values?.fuel_added_cost}
                />
              </Field>
            </div>
          </div>
        ) : (
          <Button type="button" variant="tertiary" onClick={() => setShowFuel(true)}>
            <Fuel aria-hidden size={16} strokeWidth={2} />
            Add fuel
          </Button>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        {showDetails ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-base font-semibold">
              <MapPin aria-hidden size={20} strokeWidth={1.75} />
              Route and remarks
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="From" hint="e.g. KPAO">
                <Input
                  name="departed_from"
                  className="uppercase"
                  defaultValue={state.values?.departed_from}
                />
              </Field>
              <Field label="To" hint="e.g. KTRK">
                <Input
                  name="arrived_at"
                  className="uppercase"
                  defaultValue={state.values?.arrived_at}
                />
              </Field>
            </div>
            <Field label="Remarks">
              <Textarea name="remarks" maxLength={2000} defaultValue={state.values?.remarks} />
            </Field>
          </div>
        ) : (
          <Button type="button" variant="tertiary" onClick={() => setShowDetails(true)}>
            <ChevronDown aria-hidden size={16} strokeWidth={2} />
            Add route and remarks
          </Button>
        )}
      </Card>

      {state.error ? <Alert>{state.error}</Alert> : null}

      {/* One dominant primary action, and it stays reachable on a phone. */}
      <div className="sticky bottom-0 -mx-6 border-t border-line bg-surface px-6 py-4 sm:static sm:mx-0 sm:border-0 sm:p-0">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Save flight'}
        </Button>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-secondary">
          <Info aria-hidden size={13} strokeWidth={2} />
          Saving advances the aircraft&rsquo;s meters.
        </p>
      </div>
    </form>
  );
}
