'use client';

import { useActionState, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';

import {
  previewMaintenanceRules,
  saveMaintenanceItem,
  type FormState,
} from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Status, Textarea } from '@/components/ui';
import type {
  MaintenanceCategory,
  MaintenanceItemResponse,
  MaintenanceRuleKind,
  PreviewMaintenanceResponse,
} from '@flightsquare/shared';

import { kindFor } from './shared';

/**
 * Adding or editing a tracked item (mockup 03).
 *
 * The form's whole job is the footer. Somebody typing "every 50 tach hours from
 * 1,225.0" has one question — when does that land — and §13 requires the answer
 * shown here to be the answer saving produces. It is, by construction: this
 * calls `/maintenance-items/preview`, which runs the same two database functions
 * the completion trigger does. Working the date out in the browser would be a
 * second implementation of §4.2's calendar arithmetic, and it would drift.
 */

const KINDS: { value: MaintenanceRuleKind; label: string; unit: string }[] = [
  { value: 'tach_hr', label: 'Tach hours', unit: 'hr' },
  { value: 'hobbs_hr', label: 'Hobbs hours', unit: 'hr' },
  { value: 'airframe_hr', label: 'Airframe hours', unit: 'hr' },
  { value: 'cal_month', label: 'Calendar months', unit: 'months' },
  { value: 'cal_day', label: 'Calendar days', unit: 'days' },
  { value: 'cycles', label: 'Cycles', unit: 'cycles' },
  { value: 'fixed_date', label: 'One fixed date', unit: '' },
];

const CATEGORIES: { value: MaintenanceCategory; label: string }[] = [
  { value: 'airframe', label: 'Airframe' },
  { value: 'engine', label: 'Engine' },
  { value: 'prop', label: 'Propeller' },
  { value: 'avionics', label: 'Avionics' },
  { value: 'other', label: 'Other' },
];

/** A rule as the form holds it: strings, because that is what was typed. */
interface Draft {
  key: string;
  kind: MaintenanceRuleKind;
  every: string;
  endOfMonth: boolean;
  fixedDate: string;
  anchorOn: string;
  anchorHours: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function blank(kind: MaintenanceRuleKind): Draft {
  return {
    key: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    every: '',
    // §4.2: a 12-month annual signed 12 March is due 31 March. On by default
    // for months, because that is how an annual actually works.
    endOfMonth: kind === 'cal_month',
    fixedDate: today(),
    anchorOn: today(),
    anchorHours: '',
  };
}

export function MaintenanceItemForm({
  aircraftId,
  registration,
  item,
}: {
  aircraftId: string;
  registration: string;
  /** Present when editing. The due points are the server's and are not fields. */
  item?: MaintenanceItemResponse;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveMaintenanceItem.bind(null, aircraftId, item?.id ?? null),
    {},
  );

  const [rules, setRules] = useState<Draft[]>(() =>
    item && item.rules.length > 0
      ? item.rules.map((rule) => ({
          key: rule.id,
          kind: rule.kind,
          every: rule.every ?? '',
          endOfMonth: rule.end_of_month,
          fixedDate: rule.due_on ?? today(),
          anchorOn: item.last_complied_on ?? today(),
          anchorHours: '',
        }))
      : [blank('tach_hr')],
  );
  const [grounds, setGrounds] = useState(item?.grounds_aircraft ?? false);
  const [tolerance, setTolerance] = useState(item?.tolerance_hours ?? '');
  const [preview, setPreview] = useState<PreviewMaintenanceResponse | null>(null);

  // Debounced, because it follows the keyboard.
  useEffect(() => {
    const payload = rules
      .filter((rule) => (rule.kind === 'fixed_date' ? rule.fixedDate : rule.every.trim()))
      .map((rule) => ({
        kind: rule.kind,
        ...(rule.kind === 'fixed_date'
          ? { fixed_date: rule.fixedDate }
          : { every: rule.every.trim() }),
        end_of_month: rule.endOfMonth,
        anchor_on: rule.anchorOn,
        ...(rule.anchorHours.trim() ? { anchor_hours: rule.anchorHours.trim() } : {}),
      }));

    if (payload.length === 0) {
      setPreview(null);
      return;
    }

    const timer = setTimeout(() => {
      void previewMaintenanceRules(aircraftId, payload, tolerance.trim() || undefined).then(
        // A failed preview is a blank footer, never a blocked form: the server
        // will say the same thing on save, in words.
        (result) => setPreview(result.preview ?? null),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [rules, tolerance, aircraftId]);

  function update(key: string, change: Partial<Draft>) {
    setRules((all) => all.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)));
  }

  const unused = KINDS.filter((kind) => !rules.some((rule) => rule.kind === kind.value));

  return (
    <form action={action} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          <Input
            name="name"
            required
            maxLength={200}
            placeholder="Oil and filter change"
            defaultValue={state.values?.name ?? item?.name ?? ''}
          />
        </Field>
        <Field label="Applies to">
          <Select name="category" defaultValue={item?.category ?? 'airframe'}>
            {CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Regulatory reference"
        hint="14 CFR 91.409, AD 2024-12-05, a service bulletin number."
      >
        <Input
          name="regulatory_reference"
          maxLength={100}
          defaultValue={state.values?.regulatory_reference ?? item?.regulatory_reference ?? ''}
        />
      </Field>

      <Field label="Notes">
        <Textarea
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={state.values?.description ?? item?.description ?? ''}
        />
      </Field>

      {/* Intervals -------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Interval</h2>
          {/* §3.6: an item can be due on more than one basis at once, and the
              earliest wins. Three is the limit the schema enforces. */}
          <p className="text-sm text-secondary">Whichever comes first</p>
        </div>

        {rules.map((rule, index) => {
          const kind = KINDS.find((one) => one.value === rule.kind);
          return (
            <Card key={rule.key} className="space-y-4 px-5 py-4">
              <input type="hidden" name={`rules.${index}.kind`} value={rule.kind} />

              <div className="flex items-center justify-between gap-3">
                <p className="text-base font-semibold">{kind?.label}</p>
                {rules.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRules((all) => all.filter((one) => one.key !== rule.key))}
                    aria-label={`Remove the ${kind?.label} rule`}
                    className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-subtle"
                  >
                    <X aria-hidden size={18} strokeWidth={2} />
                  </button>
                ) : null}
              </div>

              {rule.kind === 'fixed_date' ? (
                <Field label="Due on" required>
                  <Input
                    name={`rules.${index}.fixed_date`}
                    type="date"
                    required
                    value={rule.fixedDate}
                    onChange={(event) => update(rule.key, { fixedDate: event.target.value })}
                  />
                </Field>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={`Every (${kind?.unit})`} required>
                    <Input
                      name={`rules.${index}.every`}
                      inputMode="decimal"
                      required
                      className="tabular"
                      placeholder={rule.kind.endsWith('_hr') ? '50.0' : '12'}
                      value={rule.every}
                      onChange={(event) => update(rule.key, { every: event.target.value })}
                    />
                  </Field>

                  {rule.kind.endsWith('_hr') || rule.kind === 'cycles' ? (
                    <Field
                      label="Last done at"
                      hint="The meter reading when this was last completed."
                    >
                      <Input
                        name={`rules.${index}.anchor_hours`}
                        inputMode="decimal"
                        className="tabular"
                        placeholder="1225.0"
                        value={rule.anchorHours}
                        onChange={(event) => update(rule.key, { anchorHours: event.target.value })}
                      />
                    </Field>
                  ) : (
                    <Field label="Last done">
                      <Input
                        name={`rules.${index}.anchor_on`}
                        type="date"
                        value={rule.anchorOn}
                        onChange={(event) => update(rule.key, { anchorOn: event.target.value })}
                      />
                    </Field>
                  )}
                </div>
              )}

              {rule.kind === 'cal_month' ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    name={`rules.${index}.end_of_month`}
                    checked={rule.endOfMonth}
                    onChange={(event) => update(rule.key, { endOfMonth: event.target.checked })}
                    className="mt-0.5 size-4 accent-teal"
                  />
                  <span>
                    <span className="font-semibold">Due at month end</span>
                    <span className="block text-secondary">
                      An annual signed 12 March is due 31 March the following year.
                    </span>
                  </span>
                </label>
              ) : (
                /* The checkbox is absent, so the field has to be too — an
                   unchecked box posts nothing and the action reads `on`. */
                null
              )}

              {/* The date rules need somewhere to say when they were last done
                  even when the meter field took the visible slot. */}
              {rule.kind.endsWith('_hr') || rule.kind === 'cycles' ? (
                <input type="hidden" name={`rules.${index}.anchor_on`} value={rule.anchorOn} />
              ) : null}
            </Card>
          );
        })}

        {unused.length > 0 && rules.length < 3 ? (
          <div className="flex flex-wrap gap-2">
            {unused.map((kind) => (
              <button
                key={kind.value}
                type="button"
                onClick={() => setRules((all) => [...all, blank(kind.value)])}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-control px-4 text-sm font-semibold hover:bg-subtle"
              >
                <Plus aria-hidden size={16} strokeWidth={2} />
                {kind.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-secondary">
            Three bases is the limit. The earliest of them wins.
          </p>
        )}
      </section>

      {/* Consequences ----------------------------------------------- */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">When it comes due</h2>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="grounds_aircraft"
            checked={grounds}
            onChange={(event) => setGrounds(event.target.checked)}
            className="mt-0.5 size-4 accent-teal"
          />
          <span>
            <span className="font-semibold">Ground the aircraft if overdue</span>
            <span className="block text-secondary">
              Blocks new bookings. Existing ones are flagged for review, never cancelled — the club
              needs to call those members.
            </span>
          </span>
        </label>

        {/* §4.5: a restriction is not a grounding. An overdue transponder check
            is "VFR only", not an aeroplane that cannot fly. */}
        {!grounds ? (
          <Field
            label="Restriction when overdue"
            hint="Shown to pilots instead of grounding the aircraft."
          >
            <Input
              name="restriction_label"
              maxLength={100}
              placeholder="VFR only"
              defaultValue={state.values?.restriction_label ?? item?.restriction_label ?? ''}
            />
          </Field>
        ) : null}

        <Field
          label="Tolerance (hours)"
          hint="Counted as due rather than overdue within this much."
        >
          <Input
            name="tolerance_hours"
            inputMode="decimal"
            className="tabular"
            placeholder="0.0"
            value={tolerance}
            onChange={(event) => setTolerance(event.target.value)}
          />
        </Field>
      </section>

      {/* The answer to the question the form is asking --------------- */}
      {preview ? (
        <Card className="space-y-1 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Next due</p>
          <p className="tabular text-xl font-semibold">{resetLabel(preview)}</p>
          <Status kind={kindFor(preview.state)} />
        </Card>
      ) : null}

      {state.error ? <Alert>{state.error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : item ? 'Save changes' : `Add to ${registration}`}
        </Button>
        <p className="text-sm text-secondary">
          Every change to this item is logged with who made it.
        </p>
      </div>
    </form>
  );
}

function resetLabel(preview: PreviewMaintenanceResponse): string {
  return preview.rules
    .map((rule) => {
      if (rule.due_at_hours) {
        const meter =
          rule.kind === 'hobbs_hr' ? 'Hobbs' : rule.kind === 'airframe_hr' ? 'airframe' : 'tach';
        return `${rule.due_at_hours} ${meter}`;
      }
      if (rule.due_at_cycles !== null) return `${rule.due_at_cycles} cycles`;
      return rule.due_on ?? '—';
    })
    .join(' or ');
}
