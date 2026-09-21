'use client';

import { useActionState, useState, useTransition } from 'react';
import { Mail, UserMinus, X } from 'lucide-react';

import { inviteMember, revokeInvite, updateMember, type FormState } from '@/app/actions';
import { Alert, Button, Card, Field, Input, Select, Status } from '@/components/ui';
import type { InviteResponse, MemberResponse } from '@flightsquare/shared';

/**
 * Inviting somebody.
 *
 * Hidden entirely when the plan has no room, rather than shown and refused:
 * V1_SCOPE is explicit that on the free tier "the invite button is absent,
 * not broken". The 402 still happens if the request is made anyway — §8.1,
 * hiding a button is cosmetics — it just is not how anybody finds out.
 */
export function InviteForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(inviteMember, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Email" required>
            <Input
              name="email"
              type="email"
              required
              placeholder="dave@example.com"
              defaultValue={state.values?.email}
            />
          </Field>
          <Field label="Name" hint="Optional — so the roster reads as people.">
            <Input name="name" maxLength={200} defaultValue={state.values?.name} />
          </Field>
          <Field label="Role">
            <Select name="role" defaultValue={state.values?.role ?? 'pilot'}>
              <option value="pilot">Pilot</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
        </div>

        <p className="text-xs text-secondary">
          A Pilot books, flies, logs and reports squawks. An Admin also manages aircraft,
          members, rates and maintenance.
        </p>

        {state.error ? <Alert>{state.error}</Alert> : null}
        {state.saved ? (
          <Alert tone="info">Invitation sent. It is good for seven days.</Alert>
        ) : null}

        <Button type="submit" disabled={pending}>
          <Mail aria-hidden size={16} strokeWidth={2} />
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </form>
    </Card>
  );
}

/** Role and status, on the one member the row is about. */
export function MemberControls({
  member,
  isSelf,
}: {
  member: MemberResponse;
  isSelf: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (changes: { role?: string; status?: string }) =>
    startTransition(async () => {
      setError(null);
      const result = await updateMember(member.id, changes);
      if (result.error) setError(result.error);
    });

  if (member.status === 'removed') {
    return (
      <div className="flex flex-col items-end gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => run({ status: 'active' })}>
          {pending ? 'Saving…' : 'Reinstate'}
        </Button>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Select
          aria-label={`Role for ${member.email}`}
          value={member.role}
          disabled={pending}
          onChange={(event) => run({ role: event.target.value })}
          className="w-32"
        >
          <option value="pilot">Pilot</option>
          <option value="admin">Admin</option>
        </Select>

        {/*
          Not "delete". §10 and M1 both: removal is a status, and their
          flights, charges and squawks stay attached to the membership — which
          is exactly why the record has to stay too.
        */}
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => run({ status: 'removed' })}
        >
          <UserMinus aria-hidden size={16} strokeWidth={2} />
          {isSelf ? 'Leave' : 'Remove'}
        </Button>
      </div>

      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

export function RevokeInvite({ invite }: { invite: InviteResponse }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="tertiary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await revokeInvite(invite.id);
            if (result.error) setError(result.error);
          })
        }
      >
        <X aria-hidden size={16} strokeWidth={2} />
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/** Shared between the roster and the pending list. */
export function MemberStatus({ status }: { status: MemberResponse['status'] }) {
  if (status === 'active') return <Status kind="available">Active</Status>;
  if (status === 'invited') return <Status kind="neutral">Invited</Status>;
  if (status === 'suspended') return <Status kind="overdue">Suspended</Status>;
  return <Status kind="neutral">Removed</Status>;
}
