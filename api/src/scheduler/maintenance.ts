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
    const changed = await dueChanges(trx);
    if (changed.length === 0) return { tenantId, items: 0, notified: 0 };

    const recipients = await recipientsWith(trx, 'maintenance', 'write');
    if (recipients.length === 0) {
      // Nobody to tell — a club with no one holding maintenance. Stamp them
      // anyway: the alternative is looking at the same rows every night
      // forever, and when somebody is given the permission the state they
      // arrive at is the one that matters, not its history.
      await stamp(trx, changed);
      return { tenantId, items: changed.length, notified: 0 };
    }

    await queueAll(trx, 'maintenance_due', recipients, () =>
      maintenanceDueEmail({ items: changed.map(toDigestItem) }),
    );
    await stamp(trx, changed);

    return { tenantId, items: changed.length, notified: recipients.length };
  });
}

interface DueRow {
  maintenance_item_id: string;
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
    SELECT s.maintenance_item_id, a.registration, s.name, s.state,
           s.ever_complied, s.due_on, s.days_remaining, s.hours_remaining
      FROM public.maintenance_item_status s
      JOIN public.maintenance_items i ON i.id = s.maintenance_item_id
      JOIN public.aircraft a ON a.id = s.aircraft_id
     WHERE s.state IN ('due_soon', 'overdue')
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
  for (const state of ['due_soon', 'overdue'] as const) {
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
