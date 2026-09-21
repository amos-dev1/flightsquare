'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { createAircraft, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { AerodromeResponse, AircraftTypeResponse } from '@flightsquare/shared';

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
export function NewAircraftForm({
  types,
  aerodromes,
}: {
  types: AircraftTypeResponse[];
  aerodromes: AerodromeResponse[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createAircraft, {});

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <Field label="Registration" required hint="The tail number, as painted.">
          <Input
            name="registration"
            required
            autoFocus
            placeholder="N7642G"
            className="uppercase"
            defaultValue={state.values?.registration}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" hint="ICAO designator. Start typing to see the list.">
            <Input
              name="type_code"
              list="aircraft-types"
              placeholder="C172"
              className="uppercase"
              defaultValue={state.values?.type_code}
            />
            <datalist id="aircraft-types">
              {types.map((type) => (
                <option key={type.code} value={type.code}>
                  {type.manufacturer} {type.model}
                </option>
              ))}
            </datalist>
          </Field>

          <Field label="Home base" hint="Identifier. Start typing to see the list.">
            <Input
              name="home_base"
              list="aerodromes"
              placeholder="KPAO"
              className="uppercase"
              defaultValue={state.values?.home_base}
            />
            <datalist id="aerodromes">
              {aerodromes.map((aerodrome) => (
                <option key={aerodrome.ident} value={aerodrome.ident}>
                  {aerodrome.name}
                  {aerodrome.municipality ? ` — ${aerodrome.municipality}` : ''}
                </option>
              ))}
            </datalist>
          </Field>

          <Field label="Year">
            <Input
              name="year_manufactured"
              type="number"
              min={1900}
              max={2100}
              defaultValue={state.values?.year_manufactured}
            />
          </Field>
          <Field label="Seats">
            <Input
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
