import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download } from 'lucide-react';

import { ApiError, apiFetch } from '@/lib/api';
import { Card, Field, Input, PageTitle } from '@/components/ui';
import { formatBalance } from '@/lib/money';
import type { EntitlementsResponse, StatementResponse } from '@flightsquare/shared';

import { Statement } from '../statement';

/**
 * One member's statement, for a period.
 *
 * The period is in the URL rather than in component state, so a treasurer
 * can send somebody the exact statement they are looking at — and so the
 * CSV beside it downloads the same window rather than whatever the server
 * felt like.
 */
export default async function MemberStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ member: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { member } = await params;
  const { from, to } = await searchParams;

  const query = new URLSearchParams({ member });
  if (from) query.set('from', from);
  if (to) query.set('to', to);

  let statement: StatementResponse;
  let entitlements: EntitlementsResponse;
  try {
    [statement, entitlements] = await Promise.all([
      apiFetch<StatementResponse>(`/statement?${query}`),
      apiFetch<EntitlementsResponse>('/entitlements'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const csv = new URLSearchParams();
  if (from) csv.set('from', from);
  if (to) csv.set('to', to);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>{statement.name ?? statement.email}</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {statement.name ? `${statement.email} · ` : ''}
            {/*
              Only an unfiltered statement can say what somebody owes. Narrow
              it to a period and the same number means the period's net, so
              the header says which period instead and lets the totals card
              below carry the figure.
            */}
            {from || to
              ? `${from ? `from ${from}` : 'everything'}${to ? ` until ${to}` : ''}`
              : formatBalance(statement.balance_cents, statement.currency)}
          </p>
        </div>

        <Link href="/billing" className="text-sm font-semibold underline decoration-1 underline-offset-4">
          Back to billing
        </Link>
      </div>

      {/*
        A plain GET form, so the period lands in the URL. No JavaScript
        needed to change it, and the result is a link somebody can send.
      */}
      <Card className="p-5">
        <form className="flex flex-wrap items-end gap-4">
          <Field label="From">
            <Input name="from" type="date" defaultValue={from} />
          </Field>
          <Field label="Until">
            <Input name="to" type="date" defaultValue={to} />
          </Field>

          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-lg bg-brand-black px-4 text-sm font-semibold text-surface transition-colors duration-150 hover:bg-[#1F1F1F]"
          >
            Show that period
          </button>

          {/*
            Proxied through a route handler rather than linked at the API:
            the token is in an httpOnly cookie the browser cannot forward
            (§8.1's backend-for-frontend), so a direct link would arrive
            unauthenticated.
          */}
          <a
            href={`/billing/${member}/statement.csv${csv.toString() ? `?${csv}` : ''}`}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-control px-4 text-sm font-semibold hover:bg-subtle"
          >
            <Download aria-hidden size={16} strokeWidth={2} />
            Download CSV
          </a>
        </form>
      </Card>

      <Statement
        statement={statement}
        canReverse={entitlements.permissions.charges === 'write'}
      />
    </div>
  );
}
