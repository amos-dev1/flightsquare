'use client';

import { useActionState, useState, useTransition } from 'react';
import { ClipboardCheck, Sparkles } from 'lucide-react';

import { recordCompliance, seedMaintenanceItems, type FormState } from '@/app/actions';
import { Alert, Button, Field, Input } from '@/components/ui';
import type { MaintenanceItemResponse } from '@flightsquare/shared';

/**
 * Recording compliance — which is also how a seeded item gets its real date
 * for the first time, and therefore the most common thing done on this
 * screen in a tenant's first week.
 *
 * A disclosure rather than a dialog: the form is four fields, and a club
 * entering last year's annuals for three aircraft should not have to open
 * and dismiss anything.
 */
export function ComplianceForm({
  aircraftId,
  item,
}: {
  aircraftId: string;
  item: MaintenanceItemResponse;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    recordCompliance.bind(null, aircraftId, item.id),
    {},
  );

  return (
    <details className="group mt-3">
      <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-subtle">
        <ClipboardCheck aria-hidden size={16} strokeWidth={2} />
        {item.ever_complied ? 'Record compliance' : 'Record the last compliance'}
      </summary>

      <form action={action} className="mt-3 space-y-4 border-t border-line pt-4">
        <input type="hidden" name="title" value={item.name} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Signed off on"
            required
            hint={
              item.interval_months
                ? // 14 CFR 91.409 counts calendar months, so the next due
                  // date lands at the end of a month rather than on this day
                  // next year. The server does that arithmetic, not this form.
                  `Counts as ${item.interval_months} calendar months from this date.`
                : undefined
            }
          >
            <Input
              name="complied_on"
              type="date"
              required
              defaultValue={state.values?.complied_on}
            />
          </Field>

          <Field
            label={`${item.hours_meter} reading`}
            hint="Optional — needed for intervals counted in hours."
          >
            <Input
              name="complied_at_hours"
              inputMode="decimal"
              placeholder={item.current_hours ?? '1100.0'}
              className="tabular"
              defaultValue={state.values?.complied_at_hours}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Signed by">
            <Input name="signed_by" maxLength={200} defaultValue={state.values?.signed_by} />
          </Field>
          <Field label="Certificate">
            <Input
              name="signed_certificate"
              maxLength={100}
              placeholder="A&P/IA 1234567"
              defaultValue={state.values?.signed_certificate}
            />
          </Field>
        </div>

        {/*
          §3.6: this record is append-only and cannot be edited afterwards. It
          is the kind of thing that gets read back years later, so the form
          says so before it is submitted rather than after.
        */}
        <p className="text-xs text-secondary">
          Compliance records cannot be edited once saved. A correction is a new record.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? (
          <Alert tone="info">Recorded. The due date above has moved on.</Alert>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save record'}
        </Button>
      </form>
    </details>
  );
}

/** Seeding an aircraft added before the library existed. Idempotent. */
export function SeedButton({ aircraftId }: { aircraftId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await seedMaintenanceItems(aircraftId);
            if (result.error) setError(result.error);
          })
        }
      >
        <Sparkles aria-hidden size={16} strokeWidth={2} />
        {pending ? 'Adding…' : 'Add standard intervals'}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
