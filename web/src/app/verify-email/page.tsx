'use client';

import Link from 'next/link';
import { use, useState, useTransition } from 'react';

import { verifyEmail } from '@/app/actions';
import { Alert, Button, Card, Logo } from '@/components/ui';

/**
 * One click, not an automatic confirm on load.
 *
 * Mail scanners follow links; a token spent by one is a link the person can
 * never use. Nothing in v1 is gated on being verified, so the cost of asking
 * for a click is nil and the cost of not asking is a dead link.
 */
export default function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = use(searchParams);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<{ error?: string; saved?: boolean }>({});

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="-ml-2 mb-8">
        <Logo height={36} />
      </div>

      <Card className="space-y-4 p-6">
        {state.saved ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight">Email confirmed</h1>
            <p className="text-sm text-secondary">Thank you — that is all it needed.</p>
            <Link
              href="/aircraft"
              className="inline-block text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              Go to your fleet
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold tracking-tight">Confirm your email</h1>
            <p className="text-sm text-secondary">
              {token
                ? 'One tap and this address is confirmed.'
                : 'That link is incomplete. Open the one from the email again.'}
            </p>

            {state.error ? <Alert>{state.error}</Alert> : null}

            {token ? (
              <Button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    setState(await verifyEmail(token));
                  })
                }
              >
                {pending ? 'Confirming…' : 'Confirm this address'}
              </Button>
            ) : null}
          </>
        )}
      </Card>
    </main>
  );
}
