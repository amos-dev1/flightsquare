import Link from 'next/link';

import { apiFetch } from '@/lib/api';
import { Card, PageTitle, SectionHeading } from '@/components/ui';
import type { EntitlementsResponse, MeResponse, TenantResponse } from '@flightsquare/shared';

import { ProfileForm, TenantSettingsForm, VerifyEmailNotice } from './client';

/**
 * Two things on one page, because they are two things a person goes looking
 * for in the same place and §3.1 keeps them firmly apart underneath: the club
 * (tenant-scoped, and only an admin may change it) and the account (global,
 * and only its owner may change it, even here).
 */
export default async function SettingsPage() {
  const [tenant, me, entitlements] = await Promise.all([
    apiFetch<TenantResponse>('/tenant'),
    apiFetch<MeResponse>('/me'),
    apiFetch<EntitlementsResponse>('/entitlements'),
  ]);

  const canEditClub = entitlements.permissions.settings === 'write';

  return (
    <div className="space-y-6">
      <PageTitle>Settings</PageTitle>

      {me.email_verified ? null : <VerifyEmailNotice />}

      {canEditClub ? (
        <section className="space-y-3">
          <SectionHeading>{tenant.name}</SectionHeading>
          <TenantSettingsForm tenant={tenant} />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading>Your account</SectionHeading>
        <ProfileForm me={me} />
      </section>

      {/*
        §8.1: read from what the server resolved, never a table compiled in
        here — that goes stale where it cannot be corrected.

        A link rather than the subscription itself: this page is already two
        things that live in different places (§3.1), and what the club pays
        FlightSquare is a third. It is also the one thing here a Pilot may
        not see at all.
      */}
      {entitlements.permissions.subscription === 'none' ? (
        <p className="text-xs text-secondary">On the {entitlements.plan_code} plan.</p>
      ) : (
        <section className="space-y-3">
          <SectionHeading>Subscription</SectionHeading>
          <Card className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
            <p className="text-sm">
              On the <strong>{entitlements.plan_code}</strong> plan — what this club
              pays FlightSquare.
            </p>
            <Link
              href="/settings/subscription"
              className="text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              Plans and invoices
            </Link>
          </Card>
        </section>
      )}
    </div>
  );
}
