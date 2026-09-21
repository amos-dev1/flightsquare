'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { createAircraft, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { AerodromeResponse, AircraftTypeResponse } from '@flightsquare/shared';

/**
 * Two of these fields are foreign keys, and the tables behind them are seeded
 * thinly on purpose — twenty aerodromes and thirty-four types, with the real
 * lists left to an import job (§2.2). Typing anything outside those lists
 * used to be a 500 and "Something went wrong."
 *
 * So both are `datalist`-backed: still free text, because somebody based at
 * an unlisted field must be able to say so, but what we actually hold is one
 * keystroke away instead of a guess. The API now answers an unknown value
 * with a sentence rather than a crash, which is the other half of the fix.
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

        <Field
          label="Maintenance meter"
          hint="Which meter engine and inspection intervals count against. Most tenants use tach."
        >
          <Select name="maintenance_meter" defaultValue={state.values?.maintenance_meter ?? 'tach'}>
            <option value="tach">Tach</option>
            <option value="hobbs">Hobbs</option>
            <option value="airframe">Airframe hours</option>
          </Select>
        </Field>

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
