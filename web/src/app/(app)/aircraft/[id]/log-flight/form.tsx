'use client';

import { AlertTriangle, Fuel, Gauge, Info, MapPin, NotebookPen, Plus, X } from 'lucide-react';
import { useActionState, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import { logFlight, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
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

/**
 * One labelled group, always open.
 *
 * Nothing on this form is behind a disclosure any more. "Fuel" and "Route and
 * remarks" used to be buttons that revealed a panel, on the reasoning that
 * most flights buy no fuel — but the screen §3.4 calls the most important in
 * the product cannot also be the one where half the fields are hidden. The
 * cost of a visible empty field is a line of whitespace; the cost of a hidden
 * one is `fuel_remaining_after` never being recorded, which is the figure the
 * next pilot walks out to.
 */
function Group({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icon aria-hidden size={20} strokeWidth={1.75} />
          {title}
        </h2>
        {hint ? <p className="mt-1 text-sm text-secondary">{hint}</p> : null}
      </div>
      {children}
    </Card>
  );
}

/** §3.6: each defect is its own record, with its own severity. */
type SquawkDraft = { summary: string; severity: string; details: string };

const blankSquawk = (): SquawkDraft => ({ summary: '', severity: 'minor', details: '' });

export function LogFlightForm({
  aircraft,
  canSquawk,
}: {
  aircraft: AircraftResponse;
  canSquawk: boolean;
}) {
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
   *
   * It is also what makes "save again" the recovery when the flight was
   * written and a squawk was not: the flight replays, the squawk retries.
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

  /**
   * No rows until somebody asks for one.
   *
   * The one disclosure left on this form, and it earns its place where the
   * fuel and route ones did not: those were fields every flight has an answer
   * for, and most flights have no defect to report. Three open boxes under
   * "anything wrong with it?" read as a question being put to the pilot on
   * every single entry, which is how the answer stops being read.
   *
   * What matters is that filing one is *here* rather than on a second screen
   * after the fact — a button is still here.
   *
   * Read from `state.values` for the case where the form is remounted rather
   * than re-rendered: without JavaScript the action is a real POST and the
   * rows come back from the server's copy.
   */
  const [squawks, setSquawks] = useState<SquawkDraft[]>(() =>
    Array.from({ length: Number(state.values?.squawk_count ?? 0) }, (_, i) => ({
      summary: state.values?.[`squawk_summary_${i}`] ?? '',
      severity: state.values?.[`squawk_severity_${i}`] ?? 'minor',
      details: state.values?.[`squawk_details_${i}`] ?? '',
    })),
  );

  const set = (key: keyof typeof meters) => (event: { target: { value: string } }) =>
    setMeters((current) => ({ ...current, [key]: event.target.value }));

  const editSquawk = (index: number, patch: Partial<SquawkDraft>) =>
    setSquawks((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );

  const hobbsHours = hoursBetween(meters.hobbs_start, meters.hobbs_end);
  const tachHours = hoursBetween(meters.tach_start, meters.tach_end);

  /** §11: the unit travels with the number, and it is per-aircraft. */
  const unit = aircraft.fuel_units === 'litres' ? 'litres' : 'gallons';

  /** Where the aeroplane is standing, as far as this product's records go. */
  const here = aircraft.last_location ?? aircraft.home_base ?? '';

  // §8.2: a start that does not meet the last reading is flagged, never
  // rejected — so say so here rather than letting it look like an error.
  const hobbsGap =
    aircraft.hobbs !== null &&
    meters.hobbs_start !== '' &&
    Number(meters.hobbs_start) !== Number(aircraft.hobbs);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />

      {/*
        When and where first, because it is what the pilot has just finished
        doing and the easiest thing to answer while the engine is still ticking
        over. The meters need reading off the panel; this does not.
      */}
      <Group icon={MapPin} title="The flight">
        <Field label="Date" required>
          <Input
            name="flight_date"
            type="date"
            required
            defaultValue={state.values?.flight_date || today()}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          {/*
            Where it last landed is where this flight starts from, because that
            is where the aeroplane is. `last_location` is free text a pilot
            typed and never a position — there is no telemetry in this product.
            Falls back to the home base, and to nothing if neither is known.

            **To** stays empty on purpose: where it is going is not something
            the aeroplane knows, and filling it in would suggest the pilot is
            coming straight back.
          */}
          <Field label="From" hint={here ? "Where it last landed" : "e.g. KPAO"}>
            <Input
              name="departed_from"
              className="uppercase"
              autoCapitalize="characters"
              defaultValue={state.values?.departed_from ?? here}
            />
          </Field>
          <Field label="To" hint="e.g. KTRK">
            <Input
              name="arrived_at"
              className="uppercase"
              autoCapitalize="characters"
              defaultValue={state.values?.arrived_at}
            />
          </Field>
        </div>
      </Group>

      {/*
        §11: Hobbs and tach are distinguished explicitly. They run at
        different rates by design, and the difference between them is real
        data about how the aircraft was flown — so neither is derived from
        the other and neither is labelled by position alone.
      */}
      <Group
        icon={Gauge}
        title="Hours"
        hint="Read both off the panel. Neither is worked out from the other."
      >
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
              <span className="tabular font-semibold text-navy">{hobbsHours}</span> Hobbs
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
              <span className="tabular font-semibold text-navy">{tachHours}</span> tach
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
      </Group>

      {/* The unit said once, in the heading, rather than on all four labels. */}
      <Group icon={Fuel} title={`Fuel · ${unit}`}>
        {/*
          §3.4: two different things, and they must not be one field.
          **Before** and **after** are aircraft *state* — latest reading wins,
          and the next pilot walks out to it. **Added** is a *transaction*, and
          on a wet rate it credits the pilot back (§3.7).
        */}
        <div className="grid grid-cols-2 gap-4">
          {/*
            Prefilled with what the last pilot left in the tanks, which the web
            was not showing at all. Suggested and not asserted: where the pilot
            corrects it, the difference is fuel somebody added without logging
            it, which is information rather than an error (§8.2 flags, never
            rejects).
          */}
          <Field
            label="Before"
            hint={
              aircraft.fuel_remaining
                ? `Last recorded ${aircraft.fuel_remaining}`
                : 'At start-up'
            }
          >
            <Input
              name="fuel_remaining_before"
              inputMode="decimal"
              className="tabular"
              defaultValue={state.values?.fuel_remaining_before ?? (aircraft.fuel_remaining ?? '')}
            />
          </Field>
          <Field label="After" hint="What the next pilot walks out to">
            <Input
              name="fuel_remaining_after"
              inputMode="decimal"
              className="tabular"
              defaultValue={state.values?.fuel_remaining_after}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Added">
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
      </Group>

      {/*
        The heading is the label, so there is no second one — and no example
        text in the box. The suggestion that used to sit here was a defect
        ("landing light intermittent on taxi"), which is a squawk and has its
        own section below: its own record, its own severity, its own grounding
        judgement (§3.6). An empty box asks the open question it is for.
      */}
      <Group icon={NotebookPen} title="Notes">
        <label className="block">
          <span className="sr-only">Notes</span>
          <Textarea name="remarks" maxLength={2000} defaultValue={state.values?.remarks} />
        </label>
      </Group>

      {/*
        §1.5 keeps `squawks` apart from `maintenance.items` precisely so a
        pilot can report a defect without signing off work, so this belongs on
        the pilot's screen. §8.1: hiding it is cosmetics — the API refuses
        either way.
      */}
      {canSquawk ? (
        <Group
          icon={AlertTriangle}
          title="Anything wrong with it?"
          hint={
            squawks.length === 0
              ? 'Nothing to report is the usual answer. If there is something, it goes on the record from here.'
              : 'Each defect is its own record, and what you write stays as written.'
          }
        >
          <input type="hidden" name="squawk_count" value={squawks.length} />

          {squawks.map((draft, index) => (
            <fieldset key={index} className="space-y-4 border-t border-line pt-4 first:border-0 first:pt-0">
              <legend className="sr-only">Defect {index + 1}</legend>

              <Field label="What is wrong">
                <Input
                  name={`squawk_summary_${index}`}
                  maxLength={200}
                  placeholder="Left brake soft"
                  value={draft.summary}
                  onChange={(event) => editSquawk(index, { summary: event.target.value })}
                />
              </Field>

              {/*
                The reporter's judgement, in their words — never inferred from
                the words they used. Grounding is the one that reaches the
                scheduler (§3.3), so it says what it does.
              */}
              <Field
                label="Severity"
                hint="Grounding stops the aircraft being booked until it is resolved or deferred."
              >
                <Select
                  name={`squawk_severity_${index}`}
                  value={draft.severity}
                  onChange={(event) => editSquawk(index, { severity: event.target.value })}
                >
                  <option value="advisory">Advisory — worth knowing</option>
                  <option value="minor">Minor — airworthy, needs attention</option>
                  <option value="major">Major — get it looked at</option>
                  <option value="grounding">Grounding — do not fly</option>
                </Select>
              </Field>

              <Field label="Details" hint="What you saw, heard or felt.">
                <Textarea
                  name={`squawk_details_${index}`}
                  maxLength={4000}
                  placeholder="Pedal travels most of the way before it bites."
                  value={draft.details}
                  onChange={(event) => editSquawk(index, { details: event.target.value })}
                />
              </Field>

              {/* Every row goes, including the last: none of them is compulsory. */}
              <Button
                type="button"
                variant="tertiary"
                onClick={() => setSquawks((current) => current.filter((_, i) => i !== index))}
              >
                <X aria-hidden size={16} strokeWidth={2} />
                Remove this one
              </Button>
            </fieldset>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() => setSquawks((current) => [...current, blankSquawk()])}
          >
            <Plus aria-hidden size={16} strokeWidth={2} />
            {squawks.length === 0 ? 'Add a squawk' : 'Add another squawk'}
          </Button>
        </Group>
      ) : null}

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
