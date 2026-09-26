import { describe, expect, it } from 'vitest';

import {
  addDays,
  dayIn,
  dayLabel,
  startOfWeek,
  timeIn,
  todayIn,
  zonedToInstant,
} from '../src/time.js';

/**
 * The wall-clock/instant boundary, which is where scheduling goes wrong
 * quietly.
 *
 * These moved out of the web app so both clients would bucket a booking into
 * the same day. Nothing tested them there, and two of the cases below are
 * bugs that survived precisely because nothing did.
 */

const CHICAGO = 'America/Chicago';
const AUCKLAND = 'Pacific/Auckland';

describe('week arithmetic', () => {
  it('finds the Monday of the week, from any day in it', () => {
    // 2026-09-21 is itself a Monday; the rest of that week must agree.
    for (const [day, monday] of [
      ['2026-09-21', '2026-09-21'],
      ['2026-09-22', '2026-09-21'],
      ['2026-09-25', '2026-09-21'],
      // Sunday belongs to the week that started six days earlier, not to the
      // one beginning tomorrow.
      ['2026-09-27', '2026-09-21'],
      ['2026-09-28', '2026-09-28'],
    ]) {
      expect(startOfWeek(day!)).toBe(monday);
    }
  });

  it('crosses months, years and a leap day', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDays('2026-10-05', -7)).toBe('2026-09-28');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2027-01-02', -3)).toBe('2026-12-30');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('steps a week at a time without drifting through a DST change', () => {
    // US clocks go back on 2026-11-01. Seven noon-anchored days is still
    // seven days, which is why the arithmetic is in UTC rather than local.
    expect(addDays('2026-10-26', 7)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
  });
});

describe('which day an instant falls on', () => {
  it('buckets by the club, not by whoever is looking', () => {
    // 03:00 UTC on the 22nd is still the evening of the 21st in Chicago.
    const instant = '2026-09-22T03:00:00Z';
    expect(dayIn(instant, CHICAGO)).toBe('2026-09-21');
    expect(dayIn(instant, AUCKLAND)).toBe('2026-09-22');
    expect(dayIn(instant, 'UTC')).toBe('2026-09-22');
  });

  it('reads the club clock, not the runner s', () => {
    expect(timeIn('2026-09-22T14:30:00Z', CHICAGO)).toBe('09:30');
    expect(timeIn('2026-09-22T14:30:00Z', 'UTC')).toBe('14:30');
  });

  it('gives today in the club, which need not be today here', () => {
    // Not a fixed value — only that it is a plain date and that two zones
    // twelve hours apart are at most a day apart.
    expect(todayIn(CHICAGO)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const gap =
      Date.parse(`${todayIn(AUCKLAND)}T00:00:00Z`) -
      Date.parse(`${todayIn(CHICAGO)}T00:00:00Z`);
    expect([0, 86_400_000]).toContain(gap);
  });
});

describe('day headings', () => {
  it('names the day it was given, in every zone', () => {
    // A plain date has no zone. Rendering the noon anchor *as the club* put
    // every heading a day late east of UTC+12 — noon UTC is already past
    // midnight in Auckland.
    expect(dayLabel('2026-09-21')).toBe('Mon 21 Sept');
    expect(dayLabel('2026-01-01')).toBe('Thu 1 Jan');
  });
});

describe('wall clock to instant', () => {
  it('turns a club date and time into the instant it names', () => {
    // 09:00 in Chicago in September is CDT, UTC-5.
    expect(zonedToInstant('2026-09-22', '09:00', CHICAGO).toISOString()).toBe(
      '2026-09-22T14:00:00.000Z',
    );
    expect(zonedToInstant('2026-09-22', '09:00', 'UTC').toISOString()).toBe(
      '2026-09-22T09:00:00.000Z',
    );
  });

  it('is right on both sides of a daylight-saving change', () => {
    // US clocks go back at 02:00 local on 2026-11-01: CDT (-5) before,
    // CST (-6) after. This is the case the two-pass conversion exists for —
    // a single pass guesses the offset from the wrong instant and books the
    // morning after the change an hour out.
    expect(zonedToInstant('2026-10-31', '09:00', CHICAGO).toISOString()).toBe(
      '2026-10-31T14:00:00.000Z',
    );
    expect(zonedToInstant('2026-11-01', '09:00', CHICAGO).toISOString()).toBe(
      '2026-11-01T15:00:00.000Z',
    );
  });

  it('round-trips against the day and time it came from', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-06-15']) {
      const instant = zonedToInstant(day, '09:00', CHICAGO);
      expect(dayIn(instant, CHICAGO)).toBe(day);
      expect(timeIn(instant, CHICAGO)).toBe('09:00');
    }
  });

  it('refuses something that is not a date and time', () => {
    expect(() => zonedToInstant('not-a-day', '09:00', CHICAGO)).toThrow();
    expect(() => zonedToInstant('2026-09-22', '99:99', CHICAGO)).toThrow();
  });
});
