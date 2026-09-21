import { Status } from '@/components/ui';
import type { AircraftAvailabilityResponse, MaintenanceItemResponse } from '@flightsquare/shared';

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
export function DueStatus({ item }: { item: MaintenanceItemResponse }) {
  if (!item.ever_complied) return <Status kind="overdue">Not recorded</Status>;
  if (item.state === 'overdue') return <Status kind="overdue" />;
  if (item.state === 'due_soon') return <Status kind="due_soon" />;
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
