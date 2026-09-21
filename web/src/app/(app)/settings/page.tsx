import { apiFetch } from '@/lib/api';
import { PageTitle, SectionHeading } from '@/components/ui';
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

      <p className="text-xs text-secondary">
        {/* §8.1: read from what the server resolved, never a table compiled
            in here — that goes stale where it cannot be corrected. */}
        On the {entitlements.plan_code} plan.
      </p>
    </div>
  );
}
