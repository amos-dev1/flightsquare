'use client';

import { useActionState } from 'react';

import { login, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Wordmark } from '@/components/ui';

export default function LoginPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <Wordmark className="mb-2 !text-2xl" />
      {/* §11 uses the tagline sparingly — sign-in is one of the places. */}
      <p className="mb-8 text-sm text-secondary">Aircraft management, simplified.</p>

      <Card className="p-6">
        <form action={action} className="space-y-4">
          <Field label="Email" required>
            <Input name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field label="Password" required>
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
