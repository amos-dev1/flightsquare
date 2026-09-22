import type { FlightResponse } from '@flightsquare/shared';

/**
 * The few formatting decisions that more than one screen makes, kept in one
 * place so they cannot drift apart.
 *
 * Formatting only. §8.2: the client never computes anything that matters,
 * and nothing here does arithmetic beyond turning minor units into a
 * decimal at the last moment.
 */

/** §3.7 rule 3: money is integer minor units until it is displayed. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/**
 * A balance in words.
 *
 * §11: never a bare sign. "-$350.00" is ambiguous to everybody except the
 * person who wrote the query.
 */
export function formatBalance(cents: number, currency: string): string {
  if (cents === 0) return 'Settled';
  const amount = formatMoney(Math.abs(cents), currency);
  return cents > 0 ? `${amount} owed` : `${amount} in credit`;
}

/**
 * Where a flight went, when it says.
 *
 * `departed_from` and `arrived_at` are nullable free text — 0014 dropped
 * both foreign keys, because `aerodromes` holds twenty fields out of twenty
 * thousand and a key against a list that incomplete refuses almost every
 * true answer. So a flight with neither rendered as "— → —", which is noise
 * standing where a headline goes. The registration is the honest fallback:
 * it is the one thing every flight has.
 */
export function routeOf(flight: FlightResponse): string {
  if (flight.departed_from && flight.arrived_at) {
    return `${flight.departed_from} → ${flight.arrived_at}`;
  }
  if (flight.departed_from) return `From ${flight.departed_from}`;
  if (flight.arrived_at) return `To ${flight.arrived_at}`;
  return flight.aircraft_registration;
}
