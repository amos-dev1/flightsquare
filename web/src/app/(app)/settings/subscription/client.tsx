'use client';

import { useState, useTransition } from 'react';

import { openBillingPortal, startCheckout } from '@/app/actions';
import { Alert, Button } from '@/components/ui';

/**
 * The two buttons that leave the site.
 *
 * Both actions end in a redirect to the provider, so a successful press
 * never returns — which is why the only state worth keeping here is the
 * failure, and why the pending flag matters: §11 asks for feedback near the
 * action, and a button that navigates elsewhere has a noticeable gap before
 * anything visibly happens.
 */
export function UpgradeButton({
  planCode,
  planName,
  current,
}: {
  planCode: string;
  planName: string;
  current: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="space-y-2">
      <Button
        variant={current ? 'secondary' : 'primary'}
        disabled={pending || current}
        onClick={() =>
          startTransition(async () => {
            const result = await startCheckout(planCode);
            if (result?.error) setError(result.error);
          })
        }
      >
        {current ? 'Your plan' : pending ? 'Opening…' : `Move to ${planName}`}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

export function ManageBillingButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await openBillingPortal();
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? 'Opening…' : label}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
