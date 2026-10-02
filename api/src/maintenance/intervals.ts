import { sql } from 'kysely';

import type { Kysely } from 'kysely';

import type { Database, MaintenanceRuleKind, MaintenanceState } from '../db/schema.js';
import type { Tx } from '../db/context.js';

/**
 * Either a transaction or the pool.
 *
 * The preview reads nothing tenant-scoped — `next_due_for` and `rule_state` are
 * `IMMUTABLE` and touch no table — so it has no reason to insist on the
 * transaction that carries tenant context. Routes will hand it one anyway;
 * tests hand it the pool.
 */
type Queryable = Tx | Kysely<Database>;

/**
 * When a rule next comes due, and how bad that is.
 *
 * **There is no arithmetic in this file**, and that is the point. The same two
 * questions are asked by the completion trigger — which must answer them in
 * SQL, because it fires on an insert — and by SPEC §8's preview, which answers
 * them for a form nobody has saved. §13 requires that "preview matches saved
 * result", and the cheapest way to guarantee that is not a test, it is having
 * one implementation.
 *
 * So the maths lives in `public.next_due_for` (0028) and `public.rule_state`
 * (0029), and this module is the typed way to call them. A second copy here
 * would be a second end-of-month rule, a second leap-year edge, and a second
 * place to be wrong about when an aeroplane is out of annual — and the two
 * would agree right up until somebody fixed one of them.
 *
 * It is also why §8.2's "the client never computes anything that matters"
 * holds all the way down: the phone renders what the preview returned, and the
 * preview renders what the database said.
 */

/** A rule as a form has it, before anything is saved. */
export interface RuleDraft {
  kind: MaintenanceRuleKind;
  /** Decimal string, as every numeric crosses this codebase. Null for `fixed_date`. */
  every?: string | null;
  end_of_month?: boolean;
  fixed_date?: string | null;
  warn_at: string;
  critical_at: string;
}

/** Where the rule is counting from. */
export interface Anchor {
  /** The day the work was signed, `YYYY-MM-DD`. */
  on?: string | null;
  hours?: string | null;
  cycles?: number | null;
}

/** Where the aeroplane is now, for the remaining. */
export interface Meters {
  tach?: string | null;
  hobbs?: string | null;
  airframe_hours?: string | null;
  cycles?: number | null;
  /** The aircraft's local today, `YYYY-MM-DD` — never the server's (§4.2). */
  today: string;
}

export interface RulePreview {
  kind: MaintenanceRuleKind;
  due_on: string | null;
  due_at_hours: string | null;
  due_at_cycles: number | null;
  /** In the rule's own units: hours, cycles or days. Never mixed. */
  remaining: string | null;
  state: MaintenanceState;
}

/**
 * What a rule would be, given an anchor and the meters as they stand.
 *
 * One round trip for all of them rather than one each: the Add form has up to
 * three rules and recomputes on every keystroke, and three queries a keystroke
 * is three times the chance of one of them arriving out of order.
 */
export async function previewRules(
  trx: Queryable,
  rules: RuleDraft[],
  anchor: Anchor,
  meters: Meters,
  tolerance?: string | null,
): Promise<RulePreview[]> {
  if (rules.length === 0) return [];

  const rows = await Promise.all(
    rules.map(async (rule) => {
      const due = await sql<{
        due_on: string | null;
        due_at_hours: string | null;
        due_at_cycles: number | null;
      }>`
        SELECT * FROM public.next_due_for(
          ${rule.kind}, ${rule.every ?? null}::numeric,
          ${rule.end_of_month ?? false}, ${anchor.on ?? null}::date,
          ${anchor.hours ?? null}::numeric, ${anchor.cycles ?? null}::integer)
      `.execute(trx);

      const next = due.rows[0] ?? { due_on: null, due_at_hours: null, due_at_cycles: null };

      // A fixed date does not roll forward, so it keeps the date it was given.
      const dueOn = rule.kind === 'fixed_date' ? (rule.fixed_date ?? null) : next.due_on;

      const remaining = remainingFor(rule.kind, dueOn, next, meters);

      const state = await sql<{ rule_state: MaintenanceState }>`
        SELECT public.rule_state(
          ${remaining}::numeric, ${rule.warn_at}::numeric,
          ${rule.critical_at}::numeric, ${tolerance ?? null}::numeric, true)
          AS rule_state
      `.execute(trx);

      return {
        kind: rule.kind,
        due_on: dueOn,
        due_at_hours: next.due_at_hours,
        due_at_cycles: next.due_at_cycles,
        remaining,
        state: state.rows[0]?.rule_state ?? 'ok',
      };
    }),
  );

  return rows;
}

/**
 * How much is left, in the rule's own units.
 *
 * Subtraction, which is the one thing this file does do — and only because the
 * view's version of it is a `CASE` over columns that do not exist until the row
 * does. The shapes are identical, and "previews a rule exactly as the view will
 * report it once saved" in `api/test/maintenance.test.ts` holds them together.
 */
function remainingFor(
  kind: MaintenanceRuleKind,
  dueOn: string | null,
  next: { due_at_hours: string | null; due_at_cycles: number | null },
  meters: Meters,
): string | null {
  switch (kind) {
    case 'cal_month':
    case 'cal_day':
    case 'fixed_date':
      return dueOn === null ? null : String(daysBetween(meters.today, dueOn));
    case 'cycles':
      return next.due_at_cycles === null || meters.cycles == null
        ? null
        : String(next.due_at_cycles - meters.cycles);
    default: {
      const current =
        kind === 'hobbs_hr' ? meters.hobbs
        : kind === 'airframe_hr' ? meters.airframe_hours
        : meters.tach;
      return next.due_at_hours === null || current == null
        ? null
        : (Number(next.due_at_hours) - Number(current)).toFixed(1);
    }
  }
}

/**
 * Whole days between two plain dates.
 *
 * Both are calendar dates with no zone, so this anchors them at noon UTC and
 * takes the difference — the same trick `packages/shared/src/time.ts` uses, and
 * for the same reason: anchoring at midnight puts a date on the wrong side of
 * itself for half the world.
 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
