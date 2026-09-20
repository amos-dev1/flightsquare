'use client';

import { useActionState } from 'react';

import { login, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">FlightSquare</h1>
      <p className="mb-6 text-sm text-muted">Aircraft and flight management.</p>

      <Card className="p-6">
        <form action={action} className="space-y-4">
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>

          {state.error ? <Alert>{state.error}</Alert> : null}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
