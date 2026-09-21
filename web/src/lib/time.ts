/**
 * Wall-clock time in the club's zone, and the instant it means.
 *
 * Every timestamp is stored as `timestamptz` (§6) — an instant, with no zone
 * of its own. What a club types and reads is a wall clock at their field:
 * "Saturday, nine in the morning". Those are different things, and the
 * difference shows up twice a year.
 *
 * No library. The conversions below are the standard `Intl` technique, and
 * the whole of what this app needs is two functions.
 */

/**
 * How far `zone` is from UTC at a given instant, in minutes.
 *
 * Formatting the instant *as* the zone and reading the result back as though
 * it were UTC gives the offset by subtraction. It is the only way to ask
 * this without shipping a zone database.
 */
function offsetMinutesAt(instant: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Midnight comes back as hour 24 in some locales' 24-hour output.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * "2027-06-05" plus "09:00" in `zone` → the instant that names.
 *
 * Applied twice on purpose. The first pass guesses the offset using the
 * wrong instant — the one that wall clock would be in UTC — which is off by
 * an hour for a booking that straddles a daylight-saving change. The second
 * pass asks again from the corrected instant and settles. A club booking the
 * morning after the clocks go forward should not get a slot an hour out.
 */
export function zonedToInstant(date: string, time: string, zone: string): Date {
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(naive)) throw new Error(`not a date and time: ${date} ${time}`);

  let instant = new Date(naive - offsetMinutesAt(new Date(naive), zone) * 60_000);
  instant = new Date(naive - offsetMinutesAt(instant, zone) * 60_000);
  return instant;
}

/** The calendar day an instant falls on in `zone`, as `YYYY-MM-DD`. */
export function dayIn(instant: Date | string, zone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  // `en-CA` formats as YYYY-MM-DD, which is the only reason it is here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** "09:00", in the club's zone. */
export function timeIn(instant: Date | string, zone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** "Sat 5 Jun", for a column heading. */
export function dayLabel(day: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** The Monday of the week `day` falls in. Weeks start on Monday here. */
export function startOfWeek(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Today, where the club is — not where the server happens to be. */
export function todayIn(zone: string): string {
  return dayIn(new Date(), zone);
}
