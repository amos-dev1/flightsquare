'use client';

import Link from 'next/link';
import { use, useActionState } from 'react';

import { resetPassword, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Logo } from '@/components/ui';

/**
 * The link lands here; the person acts.
 *
 * Deliberately not consumed on arrival. Mail scanners and link previewers
 * follow URLs in email, and a token spent by a scanner is a reset the person
 * can never complete — so the GET shows a form and only the submit spends it.
 * The same reasoning holds for verification and for invitations.
 */
export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = use(searchParams);
  const [state, action, pending] = useActionState<FormState, FormData>(
    resetPassword.bind(null, token ?? ''),
    {},
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="-ml-2 mb-8">
        <Logo height={36} />
      </div>

      <Card className="p-6">
        {token ? (
          <form action={action} className="space-y-4">
            <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
            <Field label="New password" required hint="At least 12 characters.">
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                autoFocus
              />
            </Field>

            <p className="text-xs text-secondary">
              Everywhere you are signed in will be signed out.
            </p>

            {state.error ? <Alert>{state.error}</Alert> : null}

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? 'Saving…' : 'Set password'}
            </Button>
          </form>
        ) : (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold tracking-tight">That link is incomplete</h1>
            <p className="text-sm text-secondary">
              Open the link from the email again, or ask for a new one.
            </p>
            <Link
              href="/forgot-password"
              className="inline-block text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              Send a new link
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
