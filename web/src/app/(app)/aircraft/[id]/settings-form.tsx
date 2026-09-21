'use client';

import { useActionState } from 'react';

import { updateAircraftConfig, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { AircraftResponse } from '@flightsquare/shared';

/**
 * The per-aircraft settings of V1_SCOPE M2, after the fact.
 *
 * Not the meters: they are derived from an append-only log and app_role
 * holds no grant to write them directly (§3.4). Correcting one is a new
 * reading, which is the form above this on the page.
 */
export function AircraftSettingsForm({ aircraft }: { aircraft: AircraftResponse }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    updateAircraftConfig.bind(null, aircraft.id),
    {},
  );

  const rate =
    aircraft.default_rate_cents === null
      ? ''
      : (aircraft.default_rate_cents / 100).toFixed(2);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Home base" hint="An identifier, as people say it.">
            <Input
              name="home_base"
              className="uppercase"
              maxLength={16}
              defaultValue={state.values?.home_base ?? aircraft.home_base ?? ''}
            />
          </Field>

          <Field label="Seats">
            <Input
              name="seats"
              type="number"
              min={1}
              max={50}
              defaultValue={state.values?.seats ?? aircraft.seats ?? ''}
            />
          </Field>

          <Field label="Maintenance meter" hint="What inspection intervals count against.">
            <Select
              name="maintenance_meter"
              defaultValue={state.values?.maintenance_meter ?? aircraft.maintenance_meter}
            >
              <option value="tach">Tach</option>
              <option value="hobbs">Hobbs</option>
              <option value="airframe">Airframe hours</option>
            </Select>
          </Field>

          <Field label="Billing meter" hint="What flights are charged on.">
            <Select
              name="billing_meter"
              defaultValue={state.values?.billing_meter ?? aircraft.billing_meter}
            >
              <option value="hobbs">Hobbs</option>
              <option value="tach">Tach</option>
            </Select>
          </Field>

          <Field label="Hourly rate" hint="What a member pays per hour.">
            <Input
              name="default_rate"
              inputMode="decimal"
              placeholder="165.00"
              className="tabular"
              defaultValue={state.values?.default_rate ?? rate}
            />
          </Field>

          <Field
            label="Rate includes fuel"
            hint="Wet credits a pilot back for fuel they buy. Dry does not."
          >
            <Select
              name="rate_basis"
              defaultValue={state.values?.rate_basis ?? aircraft.rate_basis}
            >
              <option value="dry">Dry — fuel not included</option>
              <option value="wet">Wet — fuel included</option>
            </Select>
          </Field>

          <Field label="Fuel capacity" hint="Usable.">
            <Input
              name="fuel_capacity"
              inputMode="decimal"
              className="tabular"
              defaultValue={state.values?.fuel_capacity ?? aircraft.fuel_capacity ?? ''}
            />
          </Field>

          <Field label="Fuel units">
            <Select
              name="fuel_units"
              defaultValue={state.values?.fuel_units ?? aircraft.fuel_units}
            >
              <option value="gallons">Gallons</option>
              <option value="litres">Litres</option>
            </Select>
          </Field>
        </div>

        {/* §3.7: the rate a charge is computed from is snapshotted onto the
            charge, never referenced — so changing it here re-prices nothing
            that already happened. Worth saying where somebody changes it. */}
        <p className="text-xs text-secondary">
          Changing the rate applies to flights logged from now on. Charges already
          recorded keep the rate they were charged at.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Saved.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </form>
    </Card>
  );
}
