'use client';

import Link from 'next/link';
import { use, useActionState } from 'react';

import { login, verifyMfa, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Logo } from '@/components/ui';

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { next, reset } = use(searchParams);
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});
  const [codeState, codeAction, codePending] = useActionState<FormState, FormData>(verifyMfa, {});

  /*
    One page, two steps.

    The challenge arrives in the password action's own state, so there is no
    second route and no challenge id in a URL — a challenge in a query string is
    one in browser history, in a referrer, and in anything that copies the
    address bar.
  */
  const challengeId = state.values?.challenge_id ?? codeState.values?.challenge_id;
  const sentTo = state.values?.sent_to ?? codeState.values?.sent_to;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      {/* The horizontal lockup, used as supplied. §11 prefers the stacked
          variant for centred brand presentations; this sign-in is
          left-aligned, so the horizontal one is the right asset here. */}
      <div className="-ml-3 mb-2">
        <Logo height={44} />
      </div>
      {/* §11 uses the tagline sparingly — sign-in is one of the places. */}
      <p className="mb-8 text-sm text-secondary">Aircraft management, simplified.</p>

      <Card className="p-6">
        {challengeId ? (
          <form action={codeAction} className="space-y-4">
            <input type="hidden" name="challenge_id" value={challengeId} />
            <input type="hidden" name="sent_to" value={sentTo ?? ''} />
            {next ? <input type="hidden" name="next" value={next} /> : null}

            <p className="text-sm">
              We sent a six-digit code to{' '}
              <span className="font-semibold">{sentTo}</span>. It works once and expires in ten
              minutes.
            </p>

            <Field label="Code" required>
              <Input
                name="code"
                inputMode="numeric"
                /* So a password manager and the browser's own one-time-code
                   handling both recognise it. */
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                className="tabular text-center text-2xl tracking-[0.5em]"
              />
            </Field>

            {/*
              Asked, not assumed. A shared club computer is exactly where a
              remembered device should not happen, and the person at the
              keyboard is the only one who knows which this is.
            */}
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="remember_device"
                defaultChecked
                className="mt-0.5 size-4 accent-teal"
              />
              <span>
                <span className="font-semibold">Remember this device for 30 days</span>
                <span className="block text-secondary">
                  Skips the code next time on this browser. Leave it off on a shared computer.
                </span>
              </span>
            </label>

            {codeState.error ? <Alert>{codeState.error}</Alert> : null}

            <Button type="submit" disabled={codePending} className="w-full">
              {codePending ? 'Signing in…' : 'Sign in'}
            </Button>

            {/* Starting again is how a fresh code is asked for: only the
                password step can mint a new challenge. */}
            <p className="text-center text-sm">
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center text-secondary underline decoration-1 underline-offset-2 hover:text-navy"
              >
                Start again
              </Link>
            </p>
          </form>
        ) : (
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
                className="inline-flex min-h-11 items-center text-secondary underline decoration-1 underline-offset-2 hover:text-navy"
              >
                Forgot your password?
              </Link>
            </p>
          </form>
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-secondary">
        New here?{' '}
        <Link href="/signup" className="inline-flex min-h-11 items-center font-semibold underline decoration-1 underline-offset-2">
          Create an account
        </Link>
      </p>
    </main>
  );
}
