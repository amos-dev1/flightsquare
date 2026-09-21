'use client';

import { useState, useTransition } from 'react';
import { UserCheck, X } from 'lucide-react';

import { authorizeMember, withdrawAuthorization } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { AuthorizationResponse, MemberResponse } from '@flightsquare/shared';

/**
 * §3.5's checkout rule, as a screen: "is Dave signed off in the 182?"
 *
 * Note what is not here. No certificate numbers, no ratings, no hours, no
 * expiry — §3.4's boundary holds, and this records that somebody may fly a
 * particular aeroplane rather than anything about them as a pilot. The note
 * is free text for whatever the club wants to remember about the checkout.
 */
export function Authorizations({
  aircraftId,
  registration,
  authorizations,
  members,
  canWrite,
}: {
  aircraftId: string;
  registration: string;
  authorizations: AuthorizationResponse[];
  members: MemberResponse[];
  canWrite: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState('');

  const signedOff = new Set(authorizations.map((a) => a.membership_id));
  const candidates = members.filter(
    (member) => member.status === 'active' && !signedOff.has(member.id),
  );

  return (
    <Card className="p-5">
      {authorizations.length === 0 ? (
        <p className="text-sm text-secondary">
          {/* Said plainly: an empty list is a real state, and a club that
              books nothing because nobody is signed off should know why. */}
          Nobody is signed off in {registration} yet. Until somebody is, only an
          administrator can book it.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {authorizations.map((authorization) => (
            <li
              key={authorization.membership_id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0"
            >
              <div>
                <p className="text-sm font-semibold">
                  {authorization.name ?? authorization.email}
                </p>
                <p className="mt-0.5 text-xs text-secondary">
                  Signed off{' '}
                  <time dateTime={authorization.authorized_on} className="tabular">
                    {authorization.authorized_on}
                  </time>
                  {authorization.authorized_by_email
                    ? ` by ${authorization.authorized_by_email}`
                    : ''}
                  {authorization.note ? ` · ${authorization.note}` : ''}
                </p>
              </div>

              {canWrite ? (
                <Button
                  variant="tertiary"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      const result = await withdrawAuthorization(
                        aircraftId,
                        authorization.membership_id,
                      );
                      if (result.error) setError(result.error);
                    })
                  }
                >
                  <X aria-hidden size={16} strokeWidth={2} />
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite && candidates.length > 0 ? (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sign off a member">
              <Select value={choice} onChange={(event) => setChoice(event.target.value)}>
                <option value="">Choose somebody…</option>
                {candidates.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ? `${member.name} (${member.email})` : member.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note" hint="Optional — when, and by whom, if it matters.">
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                placeholder="Checked out 15 May"
              />
            </Field>
          </div>

          {/*
            Withdrawing does not cancel anything they already have. §3.3 does
            not cancel a member's Saturday from anywhere else either, and
            this is the same rule seen from a different screen.
          */}
          <p className="text-xs text-secondary">
            Withdrawing a checkout stops new bookings. Anything already on the calendar
            stands — cancel it yourself if it should not.
          </p>

          {error ? <Alert>{error}</Alert> : null}

          <Button
            disabled={pending || !choice}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await authorizeMember(aircraftId, choice, note);
                if (result.error) setError(result.error);
                else {
                  setChoice('');
                  setNote('');
                }
              })
            }
          >
            <UserCheck aria-hidden size={16} strokeWidth={2} />
            {pending ? 'Saving…' : 'Sign them off'}
          </Button>
        </div>
      ) : null}

      {error && !canWrite ? <Alert>{error}</Alert> : null}
    </Card>
  );
}
