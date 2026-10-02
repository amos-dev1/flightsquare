import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import { closeDatabase, db } from '../src/db/pool.js';
import { previewRules, type Meters, type RuleDraft } from '../src/maintenance/intervals.js';

afterAll(async () => {
  await closeDatabase();
});

/**
 * SPEC §4.2-4.4's arithmetic, and §13's worked examples.
 *
 * These run against `public.next_due_for` and `public.rule_state` directly,
 * because those are the only implementations — the completion trigger and the
 * unsaved-form preview both call them, which is how §13's "preview matches
 * saved result" is made structural rather than something a test has to keep
 * catching.
 *
 * No tenant context is set and none is needed: both functions are `IMMUTABLE`
 * and touch no table, so there is nothing for a policy to scope. That is worth
 * stating, because every other suite here opens a transaction first.
 */

/** The two functions, called the way the trigger calls them. */
async function nextDue(
  kind: string,
  every: number | null,
  endOfMonth: boolean,
  anchorOn: string | null,
  anchorHours: string | null = null,
  anchorCycles: number | null = null,
) {
  const result = await sql<{
    due_on: string | null;
    due_at_hours: string | null;
    due_at_cycles: number | null;
  }>`
    SELECT * FROM public.next_due_for(
      ${kind}, ${every}::numeric, ${endOfMonth}, ${anchorOn}::date,
      ${anchorHours}::numeric, ${anchorCycles}::integer)
  `.execute(db);
  return result.rows[0]!;
}

async function state(
  remaining: number | null,
  warnAt: number,
  criticalAt: number,
  tolerance: number | null = null,
  active = true,
) {
  const result = await sql<{ rule_state: string }>`
    SELECT public.rule_state(${remaining}::numeric, ${warnAt}::numeric,
      ${criticalAt}::numeric, ${tolerance}::numeric, ${active}) AS rule_state
  `.execute(db);
  return result.rows[0]!.rule_state;
}

describe('interval arithmetic', () => {
  it('holds §13’s oil change, every figure of it', async () => {
    /*
      "oil change every 50 tach / 4 months, last done 1,225.0 tach on Aug 2
       2026, current tach 1,270.4 → next due 1,275.0 or Dec 2 2026, 4.6 hr
       remaining"

      The one departure: §13 calls 4.6 hr `due_soon`, and §4.4's table puts
      `due_soon` at ≤ 3 hr and `upcoming` at ≤ 10. The table is normative — the
      split is what gives §9 two notification tiers with different triggers, and
      collapsing it would put an annual twenty-nine days out in the same push as
      an oil change two hours out. The mockup's "Due soon" label is the everyday
      sense of the words rather than the state name.
    */
    const hours = await nextDue('tach_hr', 50, false, null, '1225.0');
    expect(hours.due_at_hours).toBe('1275.0');

    const months = await nextDue('cal_month', 4, false, '2026-08-02');
    expect(months.due_on).toBe('2026-12-02');

    // 1,275.0 − 1,270.4, to the tenth the meter reads in.
    const remaining = Number(hours.due_at_hours) - 1270.4;
    expect(remaining.toFixed(1)).toBe('4.6');

    expect(await state(remaining, 10, 3)).toBe('upcoming');
    // And it crosses where §4.4 says it does.
    expect(await state(3.0, 10, 3)).toBe('due_soon');
    expect(await state(2.9, 10, 3)).toBe('due_soon');
  });

  it('holds §13’s annual: signed 12 Mar 2026, due 31 Mar 2027', async () => {
    // 14 CFR 91.409 counts calendar months. Getting this wrong grounds an
    // aeroplane a fortnight early, or declares an out-of-annual one fit to fly.
    const annual = await nextDue('cal_month', 12, true, '2026-03-12');
    expect(annual.due_on).toBe('2027-03-31');
  });

  it('holds §13’s reset: complete at 1,270.4 on 30 Sep 2026', async () => {
    const hours = await nextDue('tach_hr', 50, false, null, '1270.4');
    expect(hours.due_at_hours).toBe('1320.4');

    // Four months from 30 September is 30 January — the oil change does not
    // count calendar months, so it is not the 31st.
    const months = await nextDue('cal_month', 4, false, '2026-09-30');
    expect(months.due_on).toBe('2027-01-30');
  });

  it('lands end-of-month on February, leap year and not', async () => {
    // §13 asks for this by name. February is where every naive "same day next
    // interval" implementation falls over.
    expect((await nextDue('cal_month', 12, true, '2026-02-15')).due_on).toBe('2027-02-28');
    // 2028 is a leap year: the 29th exists and is the last day.
    expect((await nextDue('cal_month', 24, true, '2026-02-15')).due_on).toBe('2028-02-29');
    expect((await nextDue('cal_month', 1, true, '2027-01-31')).due_on).toBe('2027-02-28');

    // Without end-of-month, 31 January plus one month is 28 February, because
    // Postgres clamps rather than overflowing into March — which is the
    // behaviour we want and is worth pinning down rather than assuming.
    expect((await nextDue('cal_month', 1, false, '2027-01-31')).due_on).toBe('2027-02-28');
  });

  it('counts days as days, and leaves a fixed date alone', async () => {
    // A VOR check is 30 days, not a month: §4.2 keeps them different kinds
    // precisely because 30 days and "a calendar month" are not the same span.
    expect((await nextDue('cal_day', 30, false, '2026-03-15')).due_on).toBe('2026-04-14');

    // An ELT battery is stamped with a date and does not recur. Completing it
    // schedules nothing, which is the whole difference from an annual.
    const fixed = await nextDue('fixed_date', null, false, '2027-02-28');
    expect(fixed.due_on).toBeNull();
    expect(fixed.due_at_hours).toBeNull();
  });

  it('treats tolerance as permission to fly, not permission to stop warning', async () => {
    // §4.4: a 100-hour may be overflown by 10 hours to reach a shop. Past due
    // and inside tolerance is still past due — the club needs a slot booked —
    // so the item is `due_soon`, not `ok`, and only `overdue` moves.
    expect(await state(-5, 10, 3, 10)).toBe('due_soon');
    expect(await state(-10, 10, 3, 10)).toBe('due_soon');
    expect(await state(-10.1, 10, 3, 10)).toBe('overdue');
    // With no tolerance the line is zero.
    expect(await state(-0.1, 10, 3, null)).toBe('overdue');
    expect(await state(0, 10, 3, null)).toBe('due_soon');
  });

  it('says nothing rather than something wrong when it has nothing to measure', async () => {
    // A rule whose meter has never been read. `ever_complied` carries the
    // distinction between "no record" and "fine" (§3.6); the state does not
    // get to invent one.
    expect(await state(null, 10, 3)).toBe('ok');
    // An archived item is not a judgement about the aeroplane at all.
    expect(await state(-500, 10, 3, null, false)).toBe('inactive');
  });

  it('counts each rule from its own anchor', async () => {
    /*
      An oil change done at 1,225.0 tach on 2 August is two anchors, not one:
      the Add form asks "last completed" per rule because they genuinely differ.

      The preview dropped them on the way through and answered with nulls for
      everything, which is the one bug 1D's end-to-end check turned up — a
      footer that said nothing while Save would have said 1,275.0.
    */
    const [hours, months] = await previewRules(
      db,
      [
        {
          kind: 'tach_hr',
          every: '50.0',
          warn_at: '10.0',
          critical_at: '3.0',
          anchor_hours: '1225.0',
        },
        {
          kind: 'cal_month',
          every: '4',
          warn_at: '30',
          critical_at: '7',
          anchor_on: '2026-08-02',
        },
      ],
      // Deliberately empty: everything has to come from the rules themselves.
      {},
      { tach: '1270.4', today: '2026-10-01' },
    );

    expect(hours!.due_at_hours).toBe('1275.0');
    expect(hours!.remaining).toBe('4.6');
    expect(months!.due_on).toBe('2026-12-02');
  });

  it('gives the preview the same answers as the trigger would', async () => {
    /*
      §13: "preview matches saved result". It holds by construction — both call
      the same two functions — and this is the assertion that the wrapper does
      not quietly add arithmetic of its own on the way past.
    */
    const rules: RuleDraft[] = [
      { kind: 'tach_hr', every: '50.0', warn_at: '10.0', critical_at: '3.0' },
      { kind: 'cal_month', every: '4', end_of_month: false, warn_at: '30', critical_at: '7' },
    ];
    const meters: Meters = { tach: '1270.4', today: '2026-10-01' };

    const preview = await previewRules(
      db,
      rules,
      { on: '2026-08-02', hours: '1225.0' },
      meters,
    );

    expect(preview[0]).toMatchObject({
      kind: 'tach_hr',
      due_at_hours: '1275.0',
      remaining: '4.6',
      state: 'upcoming',
    });
    expect(preview[1]).toMatchObject({
      kind: 'cal_month',
      due_on: '2026-12-02',
      // 1 October to 2 December.
      remaining: '62',
      state: 'ok',
    });
  });
});
