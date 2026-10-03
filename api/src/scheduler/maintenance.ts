import { sql } from 'kysely';

import { withSession, type Tx } from '../db/context.js';
import { maintenanceDueEmail } from '../email.js';
import { queueAll, recipientsWith } from '../mail/notify.js';

/**
 * The maintenance digest — the one notice in the product with no event
 * behind it.
 *
 * Everything else is fired by somebody doing something. An annual going
 * overdue is fired by the calendar, which writes no rows, so this has to go
 * looking. What it looks for is deliberately narrow: items whose due state
 * has *changed* since anybody was last told.
 *
 * That is the difference between a notification and noise. A digest that
 * reports the same overdue annual every morning gets filtered within a week,
 * and the filter takes the one that mattered with it.
 */

export interface DigestItem {
  registration: string;
  name: string;
  state: 'due_soon' | 'overdue' | 'unrecorded';
  detail: string;
}

export interface SweepResult {
  tenantId: string;
  items: number;
  notified: number;
  /** Documents whose expiry crossed a threshold this pass. */
  documents: number;
  /** Rows written to the in-app feed (0036), which is not the email count. */
  posted: number;
  /** Future bookings flagged because the aeroplane went down under them. */
  flagged: number;
}

/**
 * One tenant, under its own context.
 *
 * §1.1: a background job sets context explicitly per tenant and loops. The
 * list of tenants came from `scheduler_role`; everything from here is
 * app_role under the ordinary policies, so this function has no more reach
 * than a request handler does.
 */
export async function sweepTenant(tenantId: string): Promise<SweepResult> {
  return withSession({ tenantId }, async (trx) => {
    // §4.5: an aeroplane can go down between sweeps, by nothing more than the
    // calendar turning over, and the bookings already on it need flagging.
    // Done first so a pilot whose Saturday just became doubtful is told in the
    // same pass that notices the item.
    const flagged = await flagBookingsOverGrounded(trx);

    /*
      Paperwork, which expires on a calendar and so has to be looked for the
      same way a date-based item does.

      Done beside the items rather than in a job of its own: it is the same
      question — what has crossed a threshold since anybody was told — and the
      per-tenant context loop §1.1 requires already exists here.
    */
    const documents = await postDocumentExpiries(trx);

    const changed = await dueChanges(trx);
    if (changed.length === 0) {
      return { tenantId, items: 0, notified: 0, posted: 0, flagged, documents };
    }

    const posted = await postToFeed(trx, changed);

    const recipients = await recipientsWith(trx, 'maintenance.items', 'write');
    if (recipients.length === 0) {
      // Nobody to email — a club with no one holding maintenance. Stamp them
      // anyway: the alternative is looking at the same rows every night
      // forever, and when somebody is given the permission the state they
      // arrive at is the one that matters, not its history.
      await stamp(trx, changed);
      return { tenantId, items: changed.length, notified: 0, posted, flagged, documents };
    }

    /*
      §9 gives the two states different audiences, and the split is the point:
      `upcoming` is a weekly digest for whoever manages maintenance, `due_soon`
      and `overdue` go out as they happen. Email carries only the second kind —
      an amber item mailed the moment it turns amber is how a digest becomes
      something people filter.
    */
    const mailable = changed.filter((row) => row.state !== 'upcoming');
    if (mailable.length > 0) {
      await queueAll(trx, 'maintenance_due', recipients, () =>
        maintenanceDueEmail({ items: mailable.map(toDigestItem) }),
      );
    }
    await stamp(trx, changed);

    return {
      tenantId,
      items: changed.length,
      notified: mailable.length > 0 ? recipients.length : 0,
      posted,
      flagged,
      documents,
    };
  });
}

interface DueRow {
  maintenance_item_id: string;
  aircraft_id: string;
  registration: string;
  name: string;
  state: string;
  ever_complied: boolean;
  due_on: string | null;
  days_remaining: number | null;
  hours_remaining: string | null;
}

async function dueChanges(trx: Tx): Promise<DueRow[]> {
  const { rows } = await sql<DueRow>`
    SELECT s.maintenance_item_id, s.aircraft_id, a.registration, s.name, s.state,
           s.ever_complied, s.due_on, s.days_remaining, s.hours_remaining
      FROM public.maintenance_item_status s
      JOIN public.maintenance_items i ON i.id = s.maintenance_item_id
      JOIN public.aircraft a ON a.id = s.aircraft_id
     WHERE s.state IN ('upcoming', 'due_soon', 'overdue')
       -- Only what has moved. notified_state holds what was last reported,
       -- so an item that goes due_soon, then overdue, is news twice, and an
       -- item that has been overdue for a month is news no more.
       AND s.state IS DISTINCT FROM i.notified_state
       -- Archived aeroplanes are still in the fleet and still have history
       -- (§5.5); nobody needs an email about the annual on one.
       AND a.status <> 'archived'
     ORDER BY a.registration, s.name
  `.execute(trx);

  return rows;
}

async function stamp(trx: Tx, rows: DueRow[]): Promise<void> {
  // One statement, and it sets each item to the state it was reported in
  // rather than to a single value — a batch can hold both kinds.
  for (const state of ['upcoming', 'due_soon', 'overdue'] as const) {
    const ids = rows.filter((row) => row.state === state).map((row) => row.maintenance_item_id);
    if (ids.length === 0) continue;

    await trx
      .updateTable('maintenance_items')
      .set({ notified_state: state })
      .where('id', 'in', ids)
      .execute();
  }
}

/**
 * The in-app feed (0036), which is not the email.
 *
 * Different audiences, deliberately. The email goes to whoever manages
 * maintenance; this goes to them *and* to every pilot holding a booking on the
 * aeroplane in the next fortnight, because §9 says so and because the person
 * who needs to know an annual lapsed is the one who was going to fly on Sunday.
 *
 * Written through `notify_member`, which holds the INSERT the application does
 * not: a role that can write another member's feed can write over a notice
 * saying the aeroplane is grounded.
 */
async function postToFeed(trx: Tx, rows: DueRow[]): Promise<number> {
  const managers = await membershipsWith(trx, 'maintenance.items', 'write');
  let posted = 0;

  for (const row of rows) {
    const audience = new Set(managers);
    if (row.state !== 'upcoming') {
      for (const member of await pilotsBookedOn(trx, row.aircraft_id)) {
        audience.add(member);
      }
    }

    const item = toDigestItem(row);
    const kind =
      row.state === 'overdue' ? 'maintenance_overdue'
      : row.state === 'due_soon' ? 'maintenance_due_soon'
      : 'maintenance_upcoming';

    for (const membershipId of audience) {
      await sql`
        SELECT public.notify_member(
          ${membershipId}::uuid, ${kind},
          ${`${row.registration}: ${row.name}`},
          ${item.detail}, 'maintenance_item', ${row.maintenance_item_id}::uuid)
      `.execute(trx);
      posted += 1;
    }
  }

  return posted;
}

/**
 * Bookings standing over an aeroplane that is no longer dispatchable.
 *
 * §4.5 is explicit that the app never cancels a booking: "existing bookings
 * that fall after the due point are flagged, and the admin and booked pilot are
 * notified." Cancelling somebody's Saturday on a date arithmetic is not a call
 * software gets to make — telling them is.
 *
 * `flag_reservations_for_grounding` (0012) already does this for a squawk and
 * for an admin grounding, both of which are row changes a trigger can see. An
 * item going overdue is the calendar turning over, which writes nothing, so it
 * has to be looked for — the same reason the digest exists at all.
 */
async function flagBookingsOverGrounded(trx: Tx): Promise<number> {
  const { rows } = await sql<{ id: string; booked_by: string }>`
    UPDATE public.reservations r
       SET needs_review = true,
           review_reason = array_to_string(v.grounding_reasons, '; ')
      -- Through the resource line: §3.3 is explicit that a reservation holds
      -- lines rather than one aircraft id, so that an instructor can become
      -- another resource type without the conflict query changing. The
      -- aeroplane is one line of possibly several.
      FROM public.reservation_resources rr
      JOIN public.aircraft_availability v ON v.aircraft_id = rr.resource_id
     WHERE rr.reservation_id = r.id
       AND rr.resource_type = 'aircraft'
       AND NOT v.available
       AND r.status = 'booked'
       AND r.starts_at > now()
       AND NOT r.needs_review
    RETURNING r.id, r.booked_by
  `.execute(trx);

  for (const row of rows) {
    await sql`
      SELECT public.notify_member(
        ${row.booked_by}::uuid, 'booking_needs_review',
        'Your booking needs a look',
        'The aircraft is not dispatchable for this slot. Nobody has cancelled it.',
        'reservation', ${row.id}::uuid)
    `.execute(trx);
  }

  return rows.length;
}

/**
 * A certificate coming up for renewal, said once.
 *
 * **Two thresholds, and never a grounding.** `aircraft_availability` keeps its
 * three inputs and the booking path never consults this. §11 forbids inferring
 * airworthiness from an absence of warnings, and the mirror binds just as hard:
 * the club may have renewed and not uploaded the scan, a registration may have
 * a renewal pending with the FAA, and a standard airworthiness certificate does
 * not expire at all. An aeroplane is not unflyable because a PDF is stale.
 *
 * **Only to whoever can act on it.** Holders of `documents: write`, and
 * deliberately not every pilot — a pilot cannot renew an insurance policy, and
 * telling them is how the bell becomes noise. That is unlike a maintenance item
 * going due, which does reach booked pilots, because they can decide not to fly.
 */
async function postDocumentExpiries(trx: Tx): Promise<number> {
  const { rows } = await sql<{
    id: string;
    aircraft_id: string;
    registration: string;
    kind: string;
    title: string;
    expires_on: string;
    days: number;
    state: 'expiring_soon' | 'expired';
  }>`
    SELECT d.id, d.aircraft_id, a.registration, d.kind, d.title, d.expires_on,
           (d.expires_on - (now() AT TIME ZONE
              coalesce(a.timezone, tn.timezone, 'UTC'))::date) AS days,
           CASE WHEN d.expires_on < (now() AT TIME ZONE
                   coalesce(a.timezone, tn.timezone, 'UTC'))::date
                THEN 'expired' ELSE 'expiring_soon' END AS state
      FROM public.aircraft_documents d
      JOIN public.aircraft a ON a.id = d.aircraft_id
      JOIN public.tenants tn ON tn.id = d.tenant_id
     WHERE d.status = 'active'
       AND d.expires_on IS NOT NULL
       -- The aeroplane's own day, not the server's: a certificate good through
       -- 31 March is good all of 31 March where the aeroplane is (0024).
       AND d.expires_on <= (now() AT TIME ZONE
             coalesce(a.timezone, tn.timezone, 'UTC'))::date + 60
       -- Nothing superseded. A renewal on file answers the question.
       AND NOT EXISTS (SELECT 1 FROM public.aircraft_documents later
                        WHERE later.supersedes_id = d.id)
       -- An archived aeroplane keeps its paperwork and needs no reminders.
       AND a.status <> 'archived'
     ORDER BY d.expires_on
  `.execute(trx);

  // Only what has moved. Two thresholds means two notices for one renewal at
  // most, which is the difference between a reminder and a thing people filter.
  const moved = await withChangedState(trx, rows);
  if (moved.length === 0) return 0;

  const managers = await membershipsWith(trx, 'documents', 'write');
  let posted = 0;

  for (const row of moved) {
    const detail =
      row.state === 'expired'
        ? `Expired ${row.expires_on}. Upload the renewal when you have it. This does not affect bookings.`
        : `Expires ${row.expires_on}, in ${row.days} days. This does not affect bookings.`;

    for (const membershipId of managers) {
      await sql`
        SELECT public.notify_member(
          ${membershipId}::uuid, 'document_expiring',
          ${`${row.registration}: ${DOCUMENT_NOUN[row.kind] ?? row.title}`},
          ${detail}, 'aircraft_document', ${row.id}::uuid)
      `.execute(trx);
      posted += 1;
    }
  }

  for (const state of ['expiring_soon', 'expired'] as const) {
    const ids = moved.filter((row) => row.state === state).map((row) => row.id);
    if (ids.length === 0) continue;
    await trx
      .updateTable('aircraft_documents')
      .set({ notified_state: state })
      .where('id', 'in', ids)
      .execute();
  }

  return posted;
}

/** The ones whose threshold is not the one already reported. */
async function withChangedState<T extends { id: string; state: string }>(
  trx: Tx,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const known = await trx
    .selectFrom('aircraft_documents')
    .select(['id', 'notified_state'])
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .execute();

  const reported = new Map(known.map((row) => [row.id, row.notified_state]));
  return rows.filter((row) => reported.get(row.id) !== row.state);
}

/** What to call it, so a notice reads like a sentence. */
const DOCUMENT_NOUN: Record<string, string> = {
  airworthiness: 'airworthiness certificate',
  registration: 'registration',
  operating_limitations: 'operating limitations',
  weight_balance: 'weight and balance',
  insurance: 'insurance certificate',
};

/** Memberships holding a permission, as ids rather than addresses. */
async function membershipsWith(
  trx: Tx,
  resource: string,
  level: string,
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT m.id
      FROM public.memberships m
      JOIN public.role_bundle_permissions p ON p.role_bundle_id = m.role_bundle_id
     WHERE m.status = 'active'
       AND p.resource = ${resource}
       AND p.level = ${level}
  `.execute(trx);
  return rows.map((row) => row.id);
}

/** Whoever has this aeroplane booked in the next fortnight (§9). */
async function pilotsBookedOn(trx: Tx, aircraftId: string): Promise<string[]> {
  const { rows } = await sql<{ booked_by: string }>`
    SELECT DISTINCT r.booked_by
      FROM public.reservations r
      -- The aeroplane is a resource line, not a column (§3.3).
      JOIN public.reservation_resources rr
        ON rr.reservation_id = r.id AND rr.resource_type = 'aircraft'
     WHERE rr.resource_id = ${aircraftId}
       AND r.status = 'booked'
       AND r.starts_at BETWEEN now() AND now() + interval '14 days'
  `.execute(trx);
  return rows.map((row) => row.booked_by);
}

/**
 * How each line reads.
 *
 * §11 is explicit that an unsupported claim about an aircraft is not
 * allowed, and "overdue" is a claim. An item seeded from the preset library
 * that nobody has ever recorded compliance against is not overdue — we have
 * no record, which is a different sentence and the one the screens already
 * use.
 */
function toDigestItem(row: DueRow): DigestItem {
  if (!row.ever_complied) {
    return {
      registration: row.registration,
      name: row.name,
      state: 'unrecorded',
      detail: 'no compliance recorded',
    };
  }

  return {
    registration: row.registration,
    name: row.name,
    state: row.state === 'overdue' ? 'overdue' : 'due_soon',
    detail: describe(row),
  };
}

function describe(row: DueRow): string {
  const parts: string[] = [];

  if (row.days_remaining !== null) {
    const days = Number(row.days_remaining);
    parts.push(
      days < 0
        ? `${Math.abs(days)} days past ${row.due_on}`
        : days === 0
          ? `due today (${row.due_on})`
          : `${days} days (${row.due_on})`,
    );
  }

  if (row.hours_remaining !== null) {
    const hours = Number(row.hours_remaining);
    parts.push(hours < 0 ? `${Math.abs(hours).toFixed(1)} hours over` : `${hours.toFixed(1)} hours`);
  }

  // Both bases at once is normal — §3.6 says the earliest wins, and the
  // person reading this is the one who decides what that means.
  return parts.length > 0 ? parts.join(', ') : 'due';
}
