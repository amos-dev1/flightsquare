'use client';

import { useActionState, useState, useTransition } from 'react';

import { resendVerification, updateProfile, updateTenant, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { MeResponse, TenantResponse } from '@flightsquare/shared';

/**
 * The zones a club might plausibly be in, plus whatever it is already set to.
 *
 * Not the full IANA list — that is 400-odd entries and a scrolling exercise
 * on a phone. The server validates against the runtime's real list, so a
 * tenant that needs one of the others is a row away rather than a release
 * away, and the current value is always present whether or not it is here.
 */
const COMMON_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function TenantSettingsForm({ tenant }: { tenant: TenantResponse }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateTenant, {});
  const zones = COMMON_ZONES.includes(tenant.timezone)
    ? COMMON_ZONES
    : [tenant.timezone, ...COMMON_ZONES];

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <Field label="Name" required hint="What appears at the top of every screen.">
          <Input
            name="name"
            required
            maxLength={200}
            defaultValue={state.values?.name ?? tenant.name}
          />
        </Field>

        <Field
          label="Time zone"
          hint="How times are shown. A Saturday booking is Saturday at the field."
        >
          <Select name="timezone" defaultValue={state.values?.timezone ?? tenant.timezone}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>

        {/*
          Shown, not editable. The slug is in URLs and in invitation links
          already out in the world, and the archetype is descriptive only —
          §3.1 forbids reading it at runtime to decide anything.
        */}
        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-semibold">Identifier</p>
            <p className="mt-1 text-sm text-secondary">{tenant.slug}</p>
          </div>
          <div>
            <p className="text-sm font-semibold">How you fly</p>
            <p className="mt-1 text-sm text-secondary">{tenant.archetype}</p>
          </div>
        </div>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Saved.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </Card>
  );
}

export function ProfileForm({ me }: { me: MeResponse }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              name="name"
              maxLength={200}
              defaultValue={state.values?.name ?? me.name ?? ''}
            />
          </Field>
          <Field label="Phone" hint="For whoever needs to reach you about an aircraft.">
            <Input
              name="phone"
              type="tel"
              maxLength={40}
              defaultValue={state.values?.phone ?? me.phone ?? ''}
            />
          </Field>
        </div>

        <div className="border-t border-line pt-4">
          <p className="text-sm font-semibold">Email</p>
          <p className="mt-1 text-sm text-secondary">{me.email}</p>
          {/* §3.1: this is the global account, shared across every club this
              person flies with, which is why a club admin cannot touch it
              and why changing it is a re-verification flow v1 does not have. */}
          <p className="mt-1 text-xs text-secondary">
            Your sign-in address, shared across every club you fly with. Ask support to
            change it.
          </p>
        </div>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? <Alert tone="info">Saved.</Alert> : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </Card>
  );
}

export function VerifyEmailNotice() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<{ error?: string; sent?: boolean }>({});

  return (
    <Card className="space-y-3 p-5">
      <p className="text-base font-semibold">Your email is not confirmed</p>
      <p className="text-sm text-secondary">
        {/* Nothing is gated on it in v1, and saying so is more honest than
            implying a consequence that does not exist. */}
        Nothing is blocked by this. Confirming it means we can reach you about an
        aircraft, and that a password reset will work when you need one.
      </p>

      {state.error ? <Alert>{state.error}</Alert> : null}
      {state.sent ? <Alert tone="info">Sent. Check your email.</Alert> : null}

      <Button
        variant="secondary"
        disabled={pending || state.sent}
        onClick={() =>
          startTransition(async () => {
            const result = await resendVerification();
            setState(result.error ? { error: result.error } : { sent: true });
          })
        }
      >
        {pending ? 'Sending…' : 'Send the link again'}
      </Button>
    </Card>
  );
}
