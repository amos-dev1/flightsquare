import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, Minus } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { Alert, Card, PageTitle, SectionHeading, Status } from '@/components/ui';
import type {
  EntitlementsResponse,
  PlanResponse,
  SubscriptionResponse,
} from '@flightsquare/shared';

import { ManageBillingButton, UpgradeButton } from './client';

/**
 * Platform billing (§3.7's left-hand column) — what this club pays
 * FlightSquare. Not `/billing`, which is what its pilots pay it.
 *
 * Everything on this page comes off the wire. §8.1 forbids a client carrying
 * its own table of what Pro includes, and this is the screen that would
 * otherwise be written that way: the comparison below is the same resolution
 * §1.4 does, and the prices are whatever the provider says it will charge.
 *
 * Web only, and deliberately so (§8.3). The iOS app has no equivalent screen
 * and will not get one.
 */
export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;

  const entitlements = await apiFetch<EntitlementsResponse>('/entitlements');
  // §4.4 gives a Pilot `subscription: none`. Nothing here is theirs, and a
  // 404 says so without describing what they are missing.
  if (entitlements.permissions.subscription === 'none') notFound();

  const [plans, subscription] = await Promise.all([
    apiFetch<PlanResponse[]>('/plans'),
    apiFetch<SubscriptionResponse>('/subscription'),
  ]);

  const canManage = entitlements.permissions.subscription === 'write';
  const current = plans.find((plan) => plan.current);
  const endsOn = subscription.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>Subscription</PageTitle>
          <p className="mt-1 text-sm text-secondary">
            What this club pays FlightSquare. Separate from{' '}
            <Link
              href="/billing"
              className="font-semibold underline decoration-1 underline-offset-2"
            >
              what your members pay you
            </Link>
            .
          </p>
        </div>
        <Link
          href="/settings"
          className="text-sm font-semibold underline decoration-1 underline-offset-4"
        >
          Back to settings
        </Link>
      </div>

      {checkout === 'success' ? (
        <Alert tone="info">
          {/* The webhook is what actually moves the plan, and it may land a
              moment after the browser comes back — so this says what happened
              rather than what they now have. */}
          Thank you. Your plan updates as soon as the payment is confirmed.
        </Alert>
      ) : null}
      {checkout === 'cancelled' ? (
        <Alert tone="info">Nothing was charged and nothing changed.</Alert>
      ) : null}

      <CurrentPlan
        plan={current}
        subscription={subscription}
        endsOn={endsOn}
        canManage={canManage}
      />

      <Usage entitlements={entitlements} />

      <section className="space-y-3">
        <SectionHeading>Plans</SectionHeading>
        <div className="grid gap-4 sm:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.code} plan={plan} canManage={canManage} />
          ))}
        </div>
        <p className="text-xs text-secondary">
          Prices are per month and exclude tax. Moving to a larger plan takes
          effect straight away; moving down takes effect at the end of the
          period you have already paid for, and nothing is deleted either way.
        </p>
      </section>
    </div>
  );
}

function CurrentPlan({
  plan,
  subscription,
  endsOn,
  canManage,
}: {
  plan: PlanResponse | undefined;
  subscription: SubscriptionResponse;
  endsOn: string | null;
  canManage: boolean;
}) {
  const failing = subscription.status === 'past_due' || subscription.status === 'unpaid';

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold">{plan?.name ?? subscription.plan_code}</p>

          <p className="mt-1 text-sm text-secondary">
            {subscription.cancel_at_period_end && endsOn ? (
              // §5.4: the outcome is shown before it happens, never sprung.
              <>
                Until {endsOn}, then Free. Nothing is deleted — an aircraft or a
                member over the Free limit stays exactly where it is, and you
                simply cannot add another.
              </>
            ) : failing ? (
              <>
                We could not take the last payment. Nothing has been switched
                off; update the card and it will be tried again.
              </>
            ) : endsOn ? (
              <>Renews {endsOn}.</>
            ) : (
              <>No subscription. Free is a complete product for one pilot and one aircraft.</>
            )}
          </p>
        </div>

        {/* §11: a state is words and an icon, never a colour on its own. */}
        {failing ? (
          <Status kind="overdue">Payment failed</Status>
        ) : subscription.cancel_at_period_end ? (
          <Status kind="due_soon">Ending</Status>
        ) : subscription.status ? (
          <Status kind="available">Active</Status>
        ) : null}
      </div>

      {canManage && subscription.status ? (
        <ManageBillingButton
          label={failing ? 'Update the card' : 'Manage billing and invoices'}
        />
      ) : null}
    </Card>
  );
}

/**
 * What they are using, against what they may use.
 *
 * The count comes from `tenant_usage`, which §4.5 maintains in the database
 * because it is the only place that sees every write. Showing it here is the
 * difference between a club knowing it is over a limit and discovering it the
 * next time somebody tries to add an aeroplane.
 */
function Usage({ entitlements }: { entitlements: EntitlementsResponse }) {
  const rows = [
    { key: 'aircraft.active', label: 'Aircraft' },
    { key: 'members.active', label: 'Members' },
  ];

  return (
    <Card className="divide-y divide-line">
      {rows.map(({ key, label }) => {
        const quota = entitlements.quotas[key];
        if (!quota) return null;

        const limit = quota.limit === 'unlimited' ? null : quota.limit;
        const used = quota.current ?? 0;
        const over = limit !== null && used > limit;

        return (
          <div key={key} className="flex items-baseline justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-semibold">{label}</p>
              {over ? (
                <p className="mt-0.5 text-xs text-secondary">
                  Over the limit. Everything keeps working — you cannot add
                  another until you move one or change plan.
                </p>
              ) : null}
            </div>
            <span className="tabular shrink-0 text-sm">
              {used} of {limit ?? 'unlimited'}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

function PlanCard({ plan, canManage }: { plan: PlanResponse; canManage: boolean }) {
  const lines: { label: string; included: boolean; detail?: string }[] = [
    { label: 'Aircraft', included: true, detail: String(plan.quotas['aircraft.active'] ?? '—') },
    { label: 'Members', included: true, detail: String(plan.quotas['members.active'] ?? '—') },
    { label: 'Maintenance and squawks', included: plan.flags['maintenance_module'] !== false },
    { label: 'Member billing', included: plan.flags['member_billing'] === true },
    { label: 'Flight logging', included: true, detail: 'unlimited' },
  ];

  return (
    <Card className={`flex flex-col gap-4 p-5 ${plan.current ? 'border-brand-black' : ''}`}>
      <div>
        <p className="text-base font-semibold">{plan.name}</p>
        <p className="tabular mt-1 text-2xl font-semibold">
          {plan.price ? formatMoney(plan.price.amount_cents, plan.price.currency) : 'Free'}
          {plan.price ? (
            <span className="text-sm font-normal text-secondary"> / {plan.price.interval}</span>
          ) : null}
        </p>
        {plan.description ? (
          <p className="mt-2 text-sm text-secondary">{plan.description}</p>
        ) : null}
      </div>

      <ul className="flex-1 space-y-1.5 text-sm">
        {lines.map((line) => (
          <li key={line.label} className="flex items-baseline gap-2">
            {line.included ? (
              <Check aria-hidden size={16} strokeWidth={2} className="shrink-0" />
            ) : (
              <Minus aria-hidden size={16} strokeWidth={2} className="shrink-0 text-secondary" />
            )}
            <span className={line.included ? '' : 'text-secondary'}>
              {line.label}
              {line.detail ? <span className="tabular"> — {line.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {/*
        Three cases, and none of them names a plan. §4.3: the moment a plan
        code appears in a conditional the property that a tier is just rows
        is gone — so "the free one" is read as "the one with no price", which
        is what actually makes it free.
      */}
      {plan.current ? (
        <p className="text-sm font-semibold text-secondary">Your plan</p>
      ) : !canManage ? null : plan.self_serve ? (
        <UpgradeButton planCode={plan.code} planName={plan.name} current={plan.current} />
      ) : plan.price ? (
        // Priced but not self-serve, or a provider we could not reach.
        // Saying so beats a button that fails.
        <p className="text-sm text-secondary">Get in touch to move to {plan.name}.</p>
      ) : (
        // No price at all: you arrive here by cancelling, which §5.1 puts at
        // the end of the period you have already paid for.
        <p className="text-sm text-secondary">
          Where you land if you cancel, at the end of the period you have paid for.
        </p>
      )}
    </Card>
  );
}
