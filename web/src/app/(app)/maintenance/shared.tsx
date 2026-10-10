import { Status, type StatusKind } from '@/components/ui';
import type {
  AircraftAvailabilityResponse,
  MaintenanceItemResponse,
  MaintenanceRuleKind,
  MaintenanceRuleResponse,
  MaintenanceState,
} from '@flightsquare/shared';

/**
 * How an item reads, and the distinction §11 insists on: never infer
 * "Airworthy" from the absence of a warning.
 *
 * An item seeded from the preset library has no compliance date behind it,
 * because adding an aircraft tells the system nothing about when its last
 * annual was. "Not recorded" and "Overdue" are different claims — one is
 * about our records and the other is about the aeroplane — and showing the
 * second when we mean the first is how a product ends up asserting something
 * about airworthiness that nobody checked.
 */
export function DueStatus({
  item,
}: {
  // The two fields this needs, so the maintenance summary's lighter row can
  // use it too. The summary and the item list disagreeing about the same
  // item would be worse than either being wrong on its own.
  item: { state: MaintenanceState; ever_complied: boolean };
}) {
  if (!item.ever_complied) return <Status kind="overdue">Not recorded</Status>;
  if (item.state === 'overdue') return <Status kind="overdue" />;
  if (item.state === 'due_soon') return <Status kind="due_soon" />;
  /*
    SPEC §4.4's fourth state, which this helper was falling through to
    "Current": something to plan around rather than to book a shop slot for.
    `Status` has carried the kind for it since the web gained one, and the
    reasoning there applies here — collapsing `upcoming` puts an annual
    forty-one days out in the same register as an oil change two hours out,
    and calling it "Current" says the opposite of what it is.
  */
  if (item.state === 'upcoming') return <Status kind="upcoming" />;
  if (item.state === 'inactive') return <Status kind="neutral">Archived</Status>;
  return <Status kind="available">Current</Status>;
}

/**
 * What is left, in words, on whichever bases the item is due — §3.6 lets an
 * item be due on more than one at a time, and the earliest wins.
 *
 * The numbers are the server's. §8.2: the client never computes anything
 * that matters, and a maintenance countdown matters.
 */
export function remainingLabel(item: MaintenanceItemResponse): string {
  // Nothing to count down from. The due date a seeded item carries is an
  // artifact of it being seeded, not a fact about the aeroplane, and
  // reporting it as "due today" would dress that up as one.
  if (!item.ever_complied) return 'No compliance on record';

  const parts: string[] = [];

  if (item.days_remaining !== null) {
    const days = item.days_remaining;
    parts.push(
      days < 0
        ? `${Math.abs(days)} days overdue`
        : days === 0
          ? 'due today'
          : `${days} days left`,
    );
  }
  if (item.hours_remaining !== null) {
    const hours = Number(item.hours_remaining);
    // The meter is named, always: Hobbs and tach run at different rates by
    // design and "10 hours left" means nothing without saying which.
    parts.push(
      hours < 0
        ? `${Math.abs(hours).toFixed(1)} ${item.hours_meter} hrs overdue`
        : `${hours.toFixed(1)} ${item.hours_meter} hrs left`,
    );
  }
  if (item.cycles_remaining !== null) {
    parts.push(`${item.cycles_remaining} cycles left`);
  }

  return parts.join(' · ') || 'No due basis set';
}

/**
 * What the governing rule has left, in words.
 *
 * The summary endpoint sends `governing_remaining` as a bare number, because
 * it is "in the rule's own units — hours for a meter rule, days for a
 * calendar one, cycles for cycles — and never mixed". A bare number is
 * therefore unreadable on its own: "406" beside an annual could be days,
 * hours or cycles, and §11 asks for Hobbs, tach and units to be named
 * wherever they could be confused.
 *
 * The arithmetic is still the server's. This only says which unit the number
 * it sent is in, which the server also told us.
 */
export function governingLabel(item: {
  governing_kind: MaintenanceRuleKind | null;
  governing_remaining: string | null;
  ever_complied: boolean;
}): string | null {
  // Nothing to count down from, and a due point on an item with no
  // compliance behind it is an artifact of how it was created rather than a
  // fact about the aeroplane.
  if (!item.ever_complied) return null;
  if (item.governing_remaining === null || item.governing_kind === null) return null;

  const value = Number(item.governing_remaining);
  if (!Number.isFinite(value)) return null;

  const unit =
    item.governing_kind === 'tach_hr'
      ? 'tach hrs'
      : item.governing_kind === 'hobbs_hr'
        ? 'Hobbs hrs'
        : item.governing_kind === 'airframe_hr'
          ? 'airframe hrs'
          : item.governing_kind === 'cycles'
            ? 'cycles'
            : 'days';

  // Hours carry a decimal, days and cycles do not — a meter reads 14.4 and a
  // calendar does not have four tenths of a day in it.
  const magnitude = unit.endsWith('hrs')
    ? Math.abs(value).toFixed(1)
    : String(Math.round(Math.abs(value)));

  return value < 0 ? `${magnitude} ${unit} overdue` : `${magnitude} ${unit} left`;
}

/** Dispatch state for one aircraft, with the reasons spelled out. */
export function AvailabilityLine({ row }: { row: AircraftAvailabilityResponse }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {row.available ? <Status kind="available" /> : <Status kind="grounded" />}
      {/*
        §11: critical information is made prominent by wording and hierarchy,
        not by colour — and an aircraft is never called airworthy here. It is
        "available", which is a statement about this product's records.
      */}
      {row.grounding_reasons.length > 0 ? (
        <span className="text-sm">{row.grounding_reasons.join(' · ')}</span>
      ) : null}
    </div>
  );
}

/**
 * SPEC §4.4's state, as a `Status` kind.
 *
 * Four states, four chips. §11 forbids colour carrying meaning on its own and
 * the web chips are monochrome anyway, so the icon and the word do all of it.
 */
export function kindFor(state: MaintenanceState): StatusKind {
  switch (state) {
    case 'overdue':
      return 'overdue';
    case 'due_soon':
      return 'due_soon';
    case 'upcoming':
      return 'upcoming';
    case 'inactive':
      return 'neutral';
    default:
      return 'available';
  }
}

/** What an item is due on, in one line: "50.0 tach hr or every 4 months". */
export function ruleSummary(rules: MaintenanceRuleResponse[]): string {
  if (rules.length === 0) return 'No interval set';
  return rules.map(ruleLabel).join(' or ');
}

export function ruleLabel(rule: MaintenanceRuleResponse): string {
  switch (rule.kind) {
    case 'cal_month':
      return `every ${rule.every ?? '?'} months${rule.end_of_month ? ' to month end' : ''}`;
    case 'cal_day':
      return `every ${rule.every ?? '?'} days`;
    case 'fixed_date':
      return 'one fixed date';
    case 'cycles':
      return `every ${rule.every ?? '?'} cycles`;
    case 'hobbs_hr':
      return `every ${Number(rule.every ?? 0).toFixed(1)} Hobbs hr`;
    case 'airframe_hr':
      return `every ${Number(rule.every ?? 0).toFixed(1)} airframe hr`;
    default:
      return `every ${Number(rule.every ?? 0).toFixed(1)} tach hr`;
  }
}

/** Where a rule's next due point lands, named so the meter is never implied. */
export function duePointLabel(rule: MaintenanceRuleResponse): string {
  if (rule.due_at_hours) {
    const meter =
      rule.kind === 'hobbs_hr' ? 'Hobbs' : rule.kind === 'airframe_hr' ? 'airframe' : 'tach';
    return `due at ${rule.due_at_hours} ${meter}`;
  }
  if (rule.due_at_cycles !== null) return `due at ${rule.due_at_cycles} cycles`;
  if (rule.due_on) return `due ${rule.due_on}`;
  return 'no due point yet';
}

/**
 * The remaining, in the governing rule's own units and rounded the way §4.3
 * asks: days under a fortnight, weeks under ten, months beyond. Nobody holds
 * "428 days" in their head, and the point of this line is that somebody can.
 */
export function remainingIn(kind: MaintenanceRuleKind | null, remaining: string | null): string {
  if (remaining === null || kind === null) return '—';
  const value = Number(remaining);
  if (!Number.isFinite(value)) return '—';

  if (kind === 'cycles') return `${value} cycles`;
  if (kind.endsWith('_hr')) {
    return value < 0 ? `${Math.abs(value).toFixed(1)} hr over` : `${value.toFixed(1)} hr left`;
  }

  const days = Math.round(value);
  if (days < 0) return `${Math.abs(days)} days over`;
  if (days === 0) return 'due today';
  if (days < 14) return `${days} days left`;
  if (days < 70) return `${Math.round(days / 7)} weeks left`;
  return `${Math.round(days / 30)} months left`;
}
