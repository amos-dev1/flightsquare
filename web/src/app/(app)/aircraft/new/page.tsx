'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { createAircraft, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

export default function NewAircraftPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(createAircraft, {});

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Add aircraft</h1>

      <Card className="p-6">
        <form action={action} className="space-y-4">
          <Field label="Registration" hint="The tail number, as painted.">
            <Input
              name="registration"
              required
              autoFocus
              placeholder="N7642G"
              className="uppercase"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" hint="ICAO designator, e.g. C172.">
              <Input name="type_code" placeholder="C172" className="uppercase" />
            </Field>
            <Field label="Home base" hint="Identifier, e.g. KPAO.">
              <Input name="home_base" placeholder="KPAO" className="uppercase" />
            </Field>
            <Field label="Year">
              <Input name="year_manufactured" type="number" min={1900} max={2100} />
            </Field>
            <Field label="Seats">
              <Input name="seats" type="number" min={1} max={50} />
            </Field>
          </div>

          <Field
            label="Maintenance meter"
            hint="Which meter engine and inspection intervals count against. Most tenants use tach."
          >
            <Select name="maintenance_meter" defaultValue="tach">
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
    </div>
  );
}
