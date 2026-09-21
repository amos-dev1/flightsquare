'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { acceptInvite, type FormState } from '@/app/actions';
import { Alert, Button, Field, Input } from '@/components/ui';
import type { InviteLookupResponse } from '@flightsquare/shared';

export function AcceptInviteForm({
  token,
  invite,
  signedIn,
}: {
  token: string;
  invite: InviteLookupResponse;
  signedIn: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    acceptInvite.bind(null, token),
    {},
  );

  /**
   * An existing account that is not currently signed in is the one case this
   * screen cannot finish. Sending them to sign in with `next` set brings
   * them straight back here rather than dropping them on the fleet page
   * wondering what happened to the invitation.
   */
  const needsSignIn = invite.has_account && !signedIn;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Join {invite.tenant_name}</h1>
      <p className="text-sm text-secondary">
        Invited as <span className="font-semibold text-brand-black">{invite.email}</span>.
      </p>

      {needsSignIn ? (
        <>
          <p className="text-sm">
            That address already has a FlightSquare account. Sign in with it and this
            invitation will be waiting.
          </p>
          <Link
            href={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
          >
            <Button className="w-full">Sign in to accept</Button>
          </Link>
        </>
      ) : (
        <form action={action} className="space-y-4">
          {invite.has_account ? null : (
            <>
              <Field label="Your name">
                <Input name="name" maxLength={200} defaultValue={state.values?.name} />
              </Field>
              <Field label="Choose a password" required hint="At least 12 characters.">
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  autoFocus
                />
              </Field>
            </>
          )}

          {state.error ? <Alert>{state.error}</Alert> : null}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Joining…' : `Join ${invite.tenant_name}`}
          </Button>
        </form>
      )}
    </div>
  );
}
