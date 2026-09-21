'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { signup, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Logo, Select } from '@/components/ui';

/**
 * A club and its first Admin, in one flow (M1). Free tier by default — §8.3
 * needs free to stand alone as a product, and nothing here asks for a card.
 */
export default function SignupPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(signup, {});

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <div className="-ml-2 mb-2">
        <Logo height={36} />
      </div>
      <p className="mb-8 text-sm text-secondary">Aircraft management, simplified.</p>

      <Card className="p-6">
        <form action={action} className="space-y-4">
          <Field
            label="Club or aircraft name"
            required
            hint="What you fly under. A single owner can use their tail number."
          >
            <Input
              name="name"
              required
              autoFocus
              placeholder="Palo Alto Flying Club"
              defaultValue={state.values?.name}
            />
          </Field>

          <Field label="Your email" required>
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={state.values?.email}
            />
          </Field>

          <Field label="Password" required hint="At least 12 characters.">
            <Input name="password" type="password" autoComplete="new-password" required />
          </Field>

          <Field
            label="How you fly"
            hint="Only changes the wording you see. Nothing is gated on it."
          >
            {/* §3.1: descriptive, and never read at runtime to decide
                behaviour — that would be §1.3 in a better disguise. */}
            <Select name="archetype" defaultValue={state.values?.archetype ?? 'solo'}>
              <option value="solo">On my own</option>
              <option value="partnership">With a partner or two</option>
              <option value="club">A flying club</option>
            </Select>
          </Field>

          {state.error ? <Alert>{state.error}</Alert> : null}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Creating…' : 'Create account'}
          </Button>

          <p className="text-center text-xs text-secondary">
            One aircraft and one pilot, free, with maintenance tracking and unlimited
            flight logging.
          </p>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-secondary">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold underline decoration-1 underline-offset-2">
          Sign in
        </Link>
      </p>
    </main>
  );
}
