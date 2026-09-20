import { redirect } from 'next/navigation';

import { selectTenant } from '@/app/actions';
import { apiFetch } from '@/lib/api';
import { Button, Card, PageTitle } from '@/components/ui';
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
        <PageTitle>No organisations</PageTitle>
        <p className="mt-2 text-sm text-secondary">
          Your account is not a member of any organisation yet.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <div className="mb-6">
        <PageTitle>Choose an organisation</PageTitle>
      </div>
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
              <Card className="flex items-center gap-4 p-5">
                <span className="flex-1 text-base font-semibold">{membership.tenant_name}</span>
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
