import { Card, Status } from '@/components/ui';
import { formatBalance, formatMoney } from '@/lib/money';
import type { StatementResponse } from '@flightsquare/shared';

import { ReverseCharge } from './client';

/**
 * A statement that explains itself.
 *
 * Every charge carries the hours, the rate applied and which rule supplied
 * it, because §3.7 rule 1 wrote all three onto the row precisely so a
 * statement never has to go back to the rate tables — and because a line a
 * member cannot understand is a line they ring the treasurer about.
 */
export function Statement({
  statement,
  canReverse,
}: {
  statement: StatementResponse;
  canReverse: boolean;
}) {
  if (statement.lines.length === 0) {
    return (
      <Card className="px-5 py-4 text-sm text-secondary">
        {statement.from || statement.to
          ? 'Nothing in that period.'
          : 'Nothing on this ledger yet. Charges appear when a flight is logged.'}
      </Card>
    );
  }

  const period = Boolean(statement.from || statement.to);

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-line">
        {statement.lines.map((line) => (
          <div key={line.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-4">
            {/*
              The date the line is about — the flight's, for anything flown.
              `dateTime` keeps the posting instant, so the markup still says
              when the row was actually written.
            */}
            <time className="tabular w-24 shrink-0 text-sm text-secondary" dateTime={line.occurred_at}>
              {line.occurred_on}
            </time>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {line.description}
                {/* Both halves of a correction stay, and the earlier one says
                    so rather than quietly disappearing (§3.7 rule 2). */}
                {line.reversed ? (
                  <span className="ml-2">
                    <Status kind="neutral">Reversed</Status>
                  </span>
                ) : null}
                {line.reverses_id ? (
                  <span className="ml-2">
                    <Status kind="neutral">Correction</Status>
                  </span>
                ) : null}
              </p>

              {line.kind === 'charge' && line.rate_cents !== null ? (
                <p className="mt-0.5 text-xs text-secondary">
                  <span className="tabular">{line.meter_hours}</span> {line.meter} hours at{' '}
                  <span className="tabular">{formatMoney(line.rate_cents, line.currency)}</span>
                  {/* Which layer of §3.7's chain answered — the difference
                      between "the club's rate" and "your rate". */}
                  {line.rate_source === 'member' ? ' (your rate)' : ' (club rate)'}
                </p>
              ) : null}
            </div>

            <span
              className={`tabular shrink-0 text-sm ${
                line.amount_cents < 0 ? 'text-secondary' : 'font-semibold'
              }`}
            >
              {formatMoney(line.amount_cents, line.currency)}
            </span>

            {canReverse && line.kind === 'charge' && !line.reversed && !line.reverses_id ? (
              <ReverseCharge id={line.id} amountCents={line.amount_cents} />
            ) : null}
          </div>
        ))}
      </Card>

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <Total label="Charged" cents={statement.charged_cents} currency={statement.currency} />
        <Total label="Fuel credited" cents={statement.credited_cents} currency={statement.currency} />
        <Total label="Adjustments" cents={statement.adjusted_cents} currency={statement.currency} />
        <div className="bg-surface px-5 py-4">
          {/*
            With a period on it this is the period's net, not what they owe
            today — and a treasurer reading "Balance" off a September
            statement would chase somebody for the wrong number.
          */}
          <p className="text-xs font-medium text-secondary">
            {period ? 'Total for the period' : 'Balance'}
          </p>
          <p className="tabular mt-1 text-lg font-semibold">
            {formatBalance(statement.balance_cents, statement.currency)}
          </p>
        </div>
      </Card>
    </div>
  );
}

function Total({ label, cents, currency }: { label: string; cents: number; currency: string }) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{formatMoney(cents, currency)}</p>
    </div>
  );
}
