import { redirect } from 'next/navigation';

import { selectTenant } from '@/app/actions';
import { apiFetch } from '@/lib/api';
import { Button, Card } from '@/components/ui';
import { readSession } from '@/lib/session';
import type { MembershipSummaryResponse } from '@flightsquare/shared';

/**
 * §3.1: one human, one login, many memberships. A club member frequently
 * also owns an aircraft of their own and belongs to two clubs at the field,
 * so which tenant a session acts in is a choice rather than a lookup.
 */
export default async function ChooseTenantPage() {
  const session = await readSession();
  if (!session) redirect('/login');

  const memberships = await apiFetch<MembershipSummaryResponse[]>('/me/memberships');
  if (memberships.length === 0) {
    return (
      <main className="mx-auto max-w-sm px-6 py-16">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">No organisations</h1>
        <p className="text-sm text-muted">
          Your account is not a member of any organisation yet.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Choose an organisation</h1>
      <ul className="space-y-3">
        {memberships.map((membership) => (
          <li key={membership.tenant_id}>
            <form
              action={async () => {
                'use server';
                await selectTenant(membership.tenant_id);
                redirect('/aircraft');
              }}
            >
              <Card className="flex items-center gap-4 p-4">
                <span className="flex-1 text-sm font-medium">{membership.tenant_name}</span>
                <Button type="submit" variant="secondary">
                  Open
                </Button>
              </Card>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
