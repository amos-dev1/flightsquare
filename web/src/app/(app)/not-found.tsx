import Link from 'next/link';
import { FileQuestion } from 'lucide-react';

import { Button, Card } from '@/components/ui';

/**
 * Where a 404 lands — and in this app that is two different things wearing
 * one face, deliberately.
 *
 * §1.6 gates a capability the tenant does not have with 404 rather than 403
 * or 402, so that a club on the free plan cannot tell from a status code
 * whether member billing exists, whether they would be allowed to use it, or
 * how close to a limit they are. That only works if the screen keeps the
 * secret too: one page for "there is nothing here", whether the row is in
 * another tenant, was never created, or belongs to a module this plan does
 * not include. The upselling happens in the UI, off entitlement data the
 * client already holds — never here.
 */
export default function AppNotFound() {
  return (
    <Card className="p-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <FileQuestion aria-hidden size={20} strokeWidth={2} />
        Nothing here
      </h1>

      <p className="mt-2 max-w-prose text-sm text-secondary">
        That page does not exist, or it is not part of what this club has. If you
        followed a link from somewhere, it may be out of date.
      </p>

      <div className="mt-5">
        <Link href="/aircraft">
          <Button type="button" variant="secondary">
            Back to the fleet
          </Button>
        </Link>
      </div>
    </Card>
  );
}
