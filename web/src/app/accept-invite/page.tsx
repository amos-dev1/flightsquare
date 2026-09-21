import Link from 'next/link';

import { ApiError, apiFetch } from '@/lib/api';
import { readSession } from '@/lib/session';
import { Card, Logo } from '@/components/ui';
import type { InviteLookupResponse } from '@flightsquare/shared';

import { AcceptInviteForm } from './form';

/**
 * The page an invitation lands on.
 *
 * Read on arrival, spent only on submit — mail scanners follow links, and a
 * token a scanner consumed is an invitation nobody can accept.
 *
 * Two shapes behind it, decided by whether that address already has a
 * FlightSquare account (§3.1: one human, one login, many memberships). A new
 * person picks a password here; somebody who already has an account signs in
 * as themselves first, because otherwise a forwarded link is a way into a
 * club as a stranger.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let invite: InviteLookupResponse | null = null;
  if (token) {
    try {
      invite = await apiFetch<InviteLookupResponse>(
        `/invites/token/${encodeURIComponent(token)}`,
        { token: '' },
      );
    } catch (error) {
      // Used, revoked, expired or never real — all the same answer, and none
      // of them say which.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }

  const session = await readSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <div className="-ml-2 mb-8">
        <Logo height={36} />
      </div>

      <Card className="p-6">
        {invite && token ? (
          <AcceptInviteForm
            token={token}
            invite={invite}
            signedIn={Boolean(session?.accessToken)}
          />
        ) : (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold tracking-tight">
              That invitation is no longer open
            </h1>
            <p className="text-sm text-secondary">
              It may have been used already, withdrawn, or simply expired. Ask whoever
              invited you to send another.
            </p>
            <Link
              href="/login"
              className="inline-block text-sm font-semibold underline decoration-1 underline-offset-4"
            >
              Sign in instead
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
