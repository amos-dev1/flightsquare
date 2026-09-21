/**
 * Money, on its way to a screen.
 *
 * §3.7 rule 3: integer minor units everywhere — the column, the API, the
 * arithmetic. This is the one place it becomes a decimal, and it becomes one
 * only to be read. Nothing here is ever added up; the totals arrive already
 * summed, in cents, by the server.
 */
export function formatMoney(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    // A club's ledger is in whole cents. Showing three decimals because a
    // currency allows them would be a different kind of wrong.
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * The same, with the sign said in words rather than left to a minus that is
 * easy to miss on a phone.
 *
 * §11: never communicate meaning through a glyph or a colour alone, and a
 * ledger is exactly where that costs somebody money.
 */
export function formatBalance(cents: number, currency = 'USD'): string {
  if (cents === 0) return 'Settled';
  return cents > 0
    ? `${formatMoney(cents, currency)} owed`
    : `${formatMoney(-cents, currency)} in credit`;
}

/** "165.00" → 16500. The one conversion inwards, done once at the form. */
export function parseMoney(input: string): number | null {
  const amount = Number(input.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}
