import Link from 'next/link';
import { notFound } from 'next/navigation';

import { apiFetch } from '@/lib/api';
import { Card, Empty, PageTitle, SectionHeading } from '@/components/ui';
import { formatBalance, formatMoney } from '@/lib/money';
import type {
  AircraftResponse,
  EntitlementsResponse,
  MemberBalanceResponse,
  MemberResponse,
  RateResponse,
  StatementResponse,
} from '@flightsquare/shared';

import { AdjustmentForm, RateForm } from './client';
import { Statement } from './statement';

/**
 * Member billing (§3.7) — pilot to club, never tenant to FlightSquare.
 *
 * One route, two readings of it, decided by what the viewer holds rather
 * than by a role name (§1.3): a treasurer sees everybody's balance and the
 * rates behind them, and a pilot sees their own statement. The API would
 * give a pilot exactly one row anyway — §10 decision 3 is enforced by the
 * policy on the ledger — so this is about what to *show*, not about what to
 * allow.
 */
export default async function BillingPage() {
  const entitlements = await apiFetch<EntitlementsResponse>('/entitlements');
  const treasurer = entitlements.permissions.charges === 'write';

  // §1.6: on a free tenant the module answers 404 and this route is not a
  // route. The nav already leaves it out; somebody arriving by an old link
  // or a bookmark gets the same nothing rather than an error page, which is
  // the point of gating with 404 in the first place.
  if (!entitlements.flags.member_billing) notFound();

  if (!treasurer) {
    // A pilot's own ledger, which is the whole of the screen for them.
    const statement = await apiFetch<StatementResponse>('/statement');
    return (
      <div className="space-y-6">
        <div>
          <PageTitle>Your charges</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            {formatBalance(statement.balance_cents, statement.currency)}
          </p>
        </div>
        <Statement statement={statement} canReverse={false} />
      </div>
    );
  }

  const [balances, members, fleet, rates, memberRates] = await Promise.all([
    apiFetch<MemberBalanceResponse[]>('/balances'),
    apiFetch<MemberResponse[]>('/members'),
    apiFetch<AircraftResponse[]>('/aircraft'),
    apiFetch<RateResponse[]>('/rates'),
    apiFetch<RateResponse[]>('/member-rates'),
  ]);

  const active = fleet.filter((aircraft) => aircraft.status !== 'archived');
  const owed = balances.reduce((total, row) => total + Math.max(row.balance_cents, 0), 0);

  // The current rate per aircraft: the rows are effective-dated and come
  // back newest first, so the first one for each aeroplane is today's.
  const current = new Map<string, RateResponse>();
  for (const rate of rates) {
    if (!current.has(rate.aircraft_id) && rate.effective_from <= new Date().toISOString().slice(0, 10)) {
      current.set(rate.aircraft_id, rate);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <PageTitle>Billing</PageTitle>
        <p className="mt-1 text-sm text-secondary">
          {/* Said plainly, because it is the number a treasurer opens this
              page for. */}
          {owed === 0
            ? 'Nothing outstanding.'
            : `${formatMoney(owed)} outstanding across ${balances.filter((b) => b.balance_cents > 0).length} members.`}
        </p>
      </div>

      <section className="space-y-3">
        <SectionHeading>What each member owes</SectionHeading>
        {balances.length === 0 ? (
          <Empty title="Nobody to bill yet" />
        ) : (
          <Card className="divide-y divide-line">
            {balances.map((balance) => (
              <Link
                key={balance.membership_id}
                href={`/billing/${balance.membership_id}`}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors duration-150 hover:bg-subtle"
              >
                <span className="text-base font-semibold">
                  {balance.name ?? balance.email}
                </span>
                <span className="tabular text-sm">
                  {formatBalance(balance.balance_cents, balance.currency)}
                </span>
              </Link>
            ))}
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading>Rates</SectionHeading>
        {active.length === 0 ? (
          <Card className="px-5 py-4 text-sm text-secondary">
            No aircraft to price yet.
          </Card>
        ) : (
          <>
            <Card className="divide-y divide-line">
              {active.map((aircraft) => {
                const rate = current.get(aircraft.id);
                return (
                  <div key={aircraft.id} className="flex flex-wrap items-baseline justify-between gap-4 px-5 py-3">
                    <span className="text-sm font-semibold">{aircraft.registration}</span>
                    <span className="text-sm text-secondary">
                      {rate ? (
                        <>
                          <span className="tabular font-semibold text-navy">
                            {formatMoney(rate.amount_cents, rate.currency)}
                          </span>{' '}
                          an hour on {aircraft.billing_meter} ·{' '}
                          {aircraft.rate_basis === 'wet' ? 'fuel included' : 'fuel not included'}
                        </>
                      ) : (
                        // No rate means no charge — never a charge of zero,
                        // which would claim somebody flew for nothing.
                        'No rate set, so flights in it are not charged'
                      )}
                    </span>
                  </div>
                );
              })}
            </Card>
            <RateForm fleet={active} members={members} />
          </>
        )}

        {memberRates.length > 0 ? (
          <Card className="divide-y divide-line">
            <p className="px-5 py-3 text-sm font-semibold">Member rates</p>
            {memberRates.map((rate) => (
              <div key={rate.id} className="flex flex-wrap items-baseline justify-between gap-4 px-5 py-3">
                <span className="text-sm">
                  {rate.member_email} in {rate.aircraft_registration}
                </span>
                <span className="tabular text-sm text-secondary">
                  {formatMoney(rate.amount_cents, rate.currency)} from {rate.effective_from}
                </span>
              </div>
            ))}
          </Card>
        ) : null}
      </section>

      <section className="space-y-3">
        <SectionHeading>Record a payment</SectionHeading>
        {/*
          V1_SCOPE M6: v1 produces statements and does not move money. The
          treasurer settles by whatever they already use, and this is where
          they say so.
        */}
        <p className="text-sm text-secondary">
          FlightSquare does not take payments. When somebody settles up — cheque, transfer,
          cash at the hangar — record it here and their balance follows.
        </p>
        <AdjustmentForm members={members} />
      </section>
    </div>
  );
}
