'use client';

import Link from 'next/link';
import { use, useActionState } from 'react';

import { login, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Logo } from '@/components/ui';

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { next, reset } = use(searchParams);
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      {/* The horizontal lockup, used as supplied. §11 prefers the stacked
          variant for centred brand presentations; this sign-in is
          left-aligned, so the horizontal one is the right asset here. */}
      <div className="-ml-2 mb-2">
        <Logo height={36} />
      </div>
      {/* §11 uses the tagline sparingly — sign-in is one of the places. */}
      <p className="mb-8 text-sm text-secondary">Aircraft management, simplified.</p>

      <Card className="p-6">
        <form action={action} className="space-y-4">
          {/* Where to go afterwards — an invitation, usually. The action
              only honours a path on this site. */}
          {next ? <input type="hidden" name="next" value={next} /> : null}

          {reset ? (
            <Alert tone="info">Your password is set. Sign in with it.</Alert>
          ) : null}

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

          <p className="text-center text-sm">
            <Link
              href="/forgot-password"
              className="text-secondary underline decoration-1 underline-offset-2 hover:text-brand-black"
            >
              Forgot your password?
            </Link>
          </p>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-secondary">
        New here?{' '}
        <Link href="/signup" className="font-semibold underline decoration-1 underline-offset-2">
          Create an account
        </Link>
      </p>
    </main>
  );
}
