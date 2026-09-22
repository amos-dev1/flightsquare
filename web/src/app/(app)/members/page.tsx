import Link from 'next/link';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, SectionHeading } from '@/components/ui';
import type {
  EntitlementsResponse,
  InviteResponse,
  MemberResponse,
  MeResponse,
} from '@flightsquare/shared';

import { InviteForm, MemberControls, MemberStatus, RevokeInvite } from './client';

/**
 * Who is in the club.
 *
 * §3.1: everything here is a membership rather than a person. The same human
 * is an Admin of their own aircraft and a Pilot at the club down the field,
 * and this page is only ever about the one membership in this tenant.
 */
export default async function MembersPage() {
  const [members, invites, entitlements, me] = await Promise.all([
    apiFetch<MemberResponse[]>('/members'),
    apiFetch<InviteResponse[]>('/invites'),
    apiFetch<EntitlementsResponse>('/entitlements'),
    apiFetch<MeResponse>('/me'),
  ]);

  const canWrite = entitlements.permissions.members === 'write';
  const active = members.filter((member) => member.status !== 'removed');
  const removed = members.filter((member) => member.status === 'removed');

  /**
   * Room for one more, in the terms the server resolved (§8.1 — never a
   * table of what a plan includes, compiled in here).
   *
   * Counting pending invitations as taken is the same arithmetic the API
   * does when it decides whether to accept one, so the button disappears at
   * the moment inviting would start failing rather than one person later.
   */
  const quota = entitlements.quotas['members.active'];
  const seats = quota?.limit === 'unlimited' ? Infinity : (quota?.limit ?? 1);
  const taken = active.length + invites.filter((invite) => !invite.expired).length;
  const hasRoom = taken < seats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>Members</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {active.length} {active.length === 1 ? 'person' : 'people'}
            {seats === Infinity ? '' : ` of ${seats}`}
            {invites.length > 0 ? `, ${invites.length} invited` : ''}
          </p>
        </div>
      </div>

      {canWrite ? (
        hasRoom ? (
          <section className="space-y-3">
            <SectionHeading>Invite somebody</SectionHeading>
            <InviteForm />
          </section>
        ) : (
          /*
           * V1_SCOPE: on a plan with no room the invite button is absent,
           * not broken. §1.6 keeps the upsell out of the status code, so it
           * belongs here — in the UI, reading entitlement data the client
           * already has.
           */
          <Card className="px-5 py-4 text-sm text-secondary">
            Your plan covers {seats === 1 ? 'one member' : `${seats} members`}, and they are
            all accounted for. Remove somebody, or{' '}
            {entitlements.permissions.subscription === 'none' ? (
              'move to a larger plan'
            ) : (
              <Link
                href="/settings/subscription"
                className="font-semibold underline decoration-1 underline-offset-2"
              >
                move to a larger plan
              </Link>
            )}
            , to invite more.
          </Card>
        )
      ) : null}

      <section className="space-y-3">
        <SectionHeading>Roster</SectionHeading>
        <Card className="divide-y divide-line">
          {active.map((member) => (
            <div
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
                  {member.name ?? member.email}
                  <MemberStatus status={member.status} />
                  {member.user_id === me.id ? (
                    <span className="text-xs font-medium text-secondary">you</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-sm text-secondary">
                  {member.name ? `${member.email} · ` : ''}
                  {member.role_name}
                  {member.joined_at
                    ? ` · joined ${new Date(member.joined_at).toLocaleDateString()}`
                    : ''}
                </p>
              </div>

              {canWrite ? (
                <MemberControls member={member} isSelf={member.user_id === me.id} />
              ) : null}
            </div>
          ))}
        </Card>
      </section>

      {invites.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>Invited</SectionHeading>
          <Card className="divide-y divide-line">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div>
                  <p className="text-base font-semibold">{invite.name ?? invite.email}</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    {invite.name ? `${invite.email} · ` : ''}
                    {invite.role ?? 'pilot'} ·{' '}
                    {invite.expired
                      ? 'expired'
                      : `expires ${new Date(invite.expires_at).toLocaleDateString()}`}
                  </p>
                </div>
                {canWrite ? <RevokeInvite invite={invite} /> : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {removed.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>No longer flying with you</SectionHeading>
          {/*
            Kept, not deleted. Their flights, charges and squawks are still
            attached to this membership, which is exactly why the row stays.
          */}
          <Card className="divide-y divide-line">
            {removed.map((member) => (
              <div
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div>
                  <p className="text-base font-semibold">{member.name ?? member.email}</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Their flights and records stay with the club.
                  </p>
                </div>
                {canWrite ? (
                  <MemberControls member={member} isSelf={member.user_id === me.id} />
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {active.length === 0 ? <Empty title="Nobody here yet" /> : null}
    </div>
  );
}
