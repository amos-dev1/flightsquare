'use client';

import { useActionState, useTransition } from 'react';

import { logReading, setAircraftStatus, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

export function ReadingForm({ aircraftId }: { aircraftId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    logReading.bind(null, aircraftId),
    {},
  );

  return (
    <Card className="p-4">
      <form action={action} className="space-y-4">
        {/*
          Three fields, all optional, because a reading carries whatever was
          actually read — a fuel stop logs Hobbs and nothing else, and the
          tach keeps the value it already had.
        */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Hobbs">
            <Input name="hobbs" inputMode="decimal" placeholder="1202.9" className="tabular" />
          </Field>
          <Field label="Tach">
            <Input name="tach" inputMode="decimal" placeholder="1100.2" className="tabular" />
          </Field>
          <Field label="Airframe">
            <Input
              name="airframe_hours"
              inputMode="decimal"
              placeholder="1202.9"
              className="tabular"
            />
          </Field>
        </div>

        <Field label="Note" hint="Optional — why this reading, if it needs saying.">
          <Input name="note" maxLength={500} />
        </Field>

        {state.error ? <Alert>{state.error}</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record reading'}
        </Button>
      </form>
    </Card>
  );
}

export function ArchiveButton({ id, status }: { id: string; status: string }) {
  const [pending, startTransition] = useTransition();
  const archived = status !== 'active';

  return (
    <Button
      variant={archived ? 'secondary' : 'danger'}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await setAircraftStatus(id, archived ? 'active' : 'archived');
        })
      }
    >
      {archived ? 'Restore' : 'Archive'}
    </Button>
  );
}
