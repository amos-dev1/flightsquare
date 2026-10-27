'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import {
  createAircraft,
  lookupRegistration,
  searchAerodromes,
  type FormState,
} from '@/app/actions';
import { Combobox } from '@/components/combobox';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type {
  AerodromeResponse,
  AircraftTypeResponse,
  RegistrationLookupResponse,
} from '@flightsquare/shared';

/**
 * Both reference fields are `datalist`-backed, and only one of them is still
 * a foreign key.
 *
 * The tables behind them are seeded thinly on purpose (§2.2): twenty
 * aerodromes and thirty-four types, with the real lists left to an import
 * job. Home base stopped being a key in 0011 — twenty of twenty thousand
 * fields refuses almost every true answer — while the type designator kept
 * its one, because `engine_type` on the other side of it decides which
 * maintenance presets the aircraft is seeded with.
 *
 * So the list suggests in both cases; it only refuses in the one where being
 * wrong would silently cost somebody an oil change.
 */
export function NewAircraftForm({ types }: { types: AircraftTypeResponse[] }) {
  /**
   * Searched, not sent whole.
   *
   * Seventy thousand aerodromes will not fit in a datalist, and the endpoint
   * caps at a hundred — so this asks for the ones matching what has been
   * typed. Debounced because it runs on a keystroke and each call is a server
   * round trip.
   */
  // Seeded from the returned state, not `defaultValue`: a controlled input
  // ignores that, and §11 §8 asks for entered values to survive a validation
  // error rather than being quietly cleared.
  const [base, setBase] = useState('');
  const [matches, setMatches] = useState<AerodromeResponse[]>([]);

  useEffect(() => {
    if (base.trim().length < 2) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void searchAerodromes(base).then((rows) => live && setMatches(rows));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base]);

  const [state, action, pending] = useActionState<FormState, FormData>(createAircraft, {});

  /*
    The FAA registry (0045), asked once the registration is typed. What it
    says fills the boxes that are still empty — never one somebody has typed
    into — and the line under Registration says where it came from, so it is
    checked rather than trusted: the registry is as current as the owner's
    last filing.
  */
  const formRef = useRef<HTMLFormElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  const seatsRef = useRef<HTMLInputElement>(null);
  const serialRef = useRef<HTMLInputElement>(null);
  const [typeDefault, setTypeDefault] = useState(state.values?.type_code);
  const [typeKey, setTypeKey] = useState(0);
  const [found, setFound] = useState<RegistrationLookupResponse | null>(null);
  const lastLooked = useRef('');

  async function lookUp(registration: string) {
    const tail = registration.trim().toUpperCase();
    if (tail === lastLooked.current) return;
    lastLooked.current = tail;
    const result = await lookupRegistration(tail);
    setFound(result);
    if (!result) return;

    const fill = (input: HTMLInputElement | null, value: string | number | null) => {
      if (input && input.value.trim() === '' && value !== null) input.value = String(value);
    };
    fill(yearRef.current, result.year_manufactured);
    fill(seatsRef.current, result.seats);
    fill(serialRef.current, result.serial_number);

    // The type is a combobox that keeps its own state, so a suggestion
    // remounts it with the new default — only while it is still empty.
    const typed = formRef.current?.elements.namedItem('type_code');
    if (result.type_code && typed instanceof HTMLInputElement && typed.value === '') {
      setTypeDefault(result.type_code);
      setTypeKey((key) => key + 1);
    }
  }

  // Re-seeded from what the action handed back: a controlled input ignores
  // `defaultValue`, and §11 §8 asks for entered values to survive a
  // validation error rather than being quietly cleared.
  const returned = state.values?.home_base;
  useEffect(() => {
    if (returned) setBase(returned);
  }, [returned]);

  return (
    <Card className="p-6">
      <form ref={formRef} action={action} className="space-y-4">
        <Field
          label="Registration"
          required
          hint="The tail number, as painted. A US one fills in what the FAA registry knows."
        >
          <Input
            name="registration"
            required
            autoFocus
            placeholder="N7642G"
            className="uppercase"
            defaultValue={state.values?.registration}
            onBlur={(event) => void lookUp(event.target.value)}
          />
        </Field>
        {found ? (
          <p role="status" className="-mt-2 text-sm text-secondary">
            From the FAA registry:{' '}
            <span className="font-medium text-navy">
              {[found.manufacturer, found.model].filter(Boolean).join(' ') || 'type not recorded'}
              {found.year_manufactured ? `, ${found.year_manufactured}` : ''}
              {found.serial_number ? `, serial ${found.serial_number}` : ''}
            </span>
            . Filled in where blank — check them against the aircraft&rsquo;s papers.
            {found.type_code ? null : ' Pick the type below; that model has no match in our list.'}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" hint="Search by make or model — “cessna”, “172”, “C172”.">
            <Combobox
              key={typeKey}
              name="type_code"
              placeholder="Cessna 172"
              defaultValue={typeDefault}
              options={types.map((type) => ({
                value: type.code,
                label: `${type.manufacturer} ${type.model}`,
                hint: type.code,
              }))}
            />
          </Field>

          <Field label="Home base" hint="Identifier, or the name of the field.">
            <Input
              name="home_base"
              list="aerodromes"
              placeholder="KPAO"
              className="uppercase"
              value={base}
              onChange={(event) => setBase(event.target.value)}
            />
            <datalist id="aerodromes">
              {matches.map((aerodrome) => (
                <option key={aerodrome.ident} value={aerodrome.ident}>
                  {aerodrome.name}
                  {aerodrome.municipality ? ` — ${aerodrome.municipality}` : ''}
                </option>
              ))}
            </datalist>
          </Field>

          <Field label="Serial number">
            <Input
              ref={serialRef}
              name="serial_number"
              maxLength={64}
              defaultValue={state.values?.serial_number}
            />
          </Field>
          <Field label="Year">
            <Input
              ref={yearRef}
              name="year_manufactured"
              type="number"
              min={1900}
              max={2100}
              defaultValue={state.values?.year_manufactured}
            />
          </Field>
          <Field label="Seats">
            <Input
              ref={seatsRef}
              name="seats"
              type="number"
              min={1}
              max={50}
              defaultValue={state.values?.seats}
            />
          </Field>
        </div>

        {/*
          §3.7: which meter maintenance counts on and which one the money
          counts on are two questions, and frequently two answers — Hobbs for
          billing and tach for engine intervals is the common pairing. Two
          controls, so neither can be mistaken for the other.
        */}
        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field
            label="Maintenance meter"
            hint="What inspection intervals count against. Usually tach."
          >
            <Select
              name="maintenance_meter"
              defaultValue={state.values?.maintenance_meter ?? 'tach'}
            >
              <option value="tach">Tach</option>
              <option value="hobbs">Hobbs</option>
              <option value="airframe">Airframe hours</option>
            </Select>
          </Field>

          <Field label="Billing meter" hint="What flights are charged on. Usually Hobbs.">
            <Select name="billing_meter" defaultValue={state.values?.billing_meter ?? 'hobbs'}>
              <option value="hobbs">Hobbs</option>
              <option value="tach">Tach</option>
            </Select>
          </Field>

          <Field
            label="Hourly rate"
            hint="What a member pays per hour. You can leave this until later."
          >
            <Input
              name="default_rate"
              inputMode="decimal"
              placeholder="165.00"
              className="tabular"
              defaultValue={state.values?.default_rate}
            />
          </Field>

          <Field
            label="Rate includes fuel"
            hint="Wet: fuel a pilot buys is credited back to them. Dry: it is their own cost."
          >
            <Select name="rate_basis" defaultValue={state.values?.rate_basis ?? 'dry'}>
              <option value="dry">Dry — fuel not included</option>
              <option value="wet">Wet — fuel included</option>
            </Select>
          </Field>

          <Field label="Fuel capacity" hint="Usable, for the low-level warning.">
            <Input
              name="fuel_capacity"
              inputMode="decimal"
              placeholder="53.0"
              className="tabular"
              defaultValue={state.values?.fuel_capacity}
            />
          </Field>

          <Field label="Fuel units">
            <Select name="fuel_units" defaultValue={state.values?.fuel_units ?? 'gallons'}>
              <option value="gallons">Gallons</option>
              <option value="litres">Litres</option>
            </Select>
          </Field>
        </div>

        {/*
          The only time a meter is set rather than advanced. After this they
          move through flight logs or an explicit correction — never by
          editing the aircraft — because everything downstream is derived
          from an append-only log (§3.4).
        */}
        <div className="border-t border-line pt-4">
          <p className="text-sm font-semibold">Where the meters stand today</p>
          <p className="mt-1 text-xs text-secondary">
            Read them off the panel. From here on they advance when flights are logged.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
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
        </div>

        {state.error ? <Alert>{state.error}</Alert> : null}

        <div className="flex gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add aircraft'}
          </Button>
          <Link href="/aircraft">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
        </div>
      </form>
    </Card>
  );
}
