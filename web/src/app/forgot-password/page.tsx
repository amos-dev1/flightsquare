'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { requestPasswordReset, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Logo } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    requestPasswordReset,
    {},
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="-ml-2 mb-8">
        <Logo height={36} />
      </div>

      <Card className="p-6">
        {state.saved ? (
          /*
           * The same sentence whatever the address. The API will not tell us
           * whether an account exists — that is the point of it — and this
           * screen must not appear to know either.
           */
          <div className="space-y-3">
            <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
            <p className="text-sm text-secondary">
              If there is a FlightSquare account on that address, a link to set a new
              password is on its way. It is good for one hour.
            </p>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
            <Field label="Email" required>
              <Input name="email" type="email" autoComplete="email" required autoFocus />
            </Field>

            {state.error ? <Alert>{state.error}</Alert> : null}

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? 'Sending…' : 'Send the link'}
            </Button>
          </form>
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-secondary">
        <Link href="/login" className="font-semibold underline decoration-1 underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
