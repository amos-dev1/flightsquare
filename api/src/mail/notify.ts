import type { Tx } from '../db/context.js';
import type { OutboxKind, RenderedEmail } from '../email.js';
import type { RequiredLevel, Resource } from '../permissions.js';

/**
 * Who to tell, and how to tell them.
 *
 * Two rules hold everything here together:
 *
 * **Recipients are resolved by permission, never by role name.** "Tell the
 * admins" is not a thing this code can express, because §1.5 makes a role a
 * bundle of pairs and nothing branches on its name — a club that invents a
 * "Maintenance Controller" bundle with `maintenance: write` gets the squawk
 * notice without anybody editing this file, which is the whole point of
 * roles being data.
 *
 * **Queuing happens in the transaction that did the thing.** A booking that
 * fails the exclusion constraint queues no confirmation, and a confirmation
 * that cannot be written rolls back the booking. The alternative — send
 * after commit — is how people get told about bookings that do not exist.
 */

export interface Recipient {
  membership_id: string;
  email: string;
  name: string | null;
}

const RANK = { none: 0, read: 1, write: 2 } as const;

/**
 * Everyone in this tenant who holds at least `level` on `resource`.
 *
 * Runs under tenant context like everything else, so the policy on
 * `memberships` is what scopes it — there is no tenant predicate here to
 * forget.
 */
export async function recipientsWith(
  trx: Tx,
  resource: Resource,
  level: RequiredLevel,
  options: { except?: string | null } = {},
): Promise<Recipient[]> {
  const rows = await trx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('role_bundle_permissions as p', 'p.role_bundle_id', 'm.role_bundle_id')
    .select(['m.id as membership_id', 'u.email', 'u.name', 'p.level'])
    .where('m.status', '=', 'active')
    .where('p.resource', '=', resource)
    .execute();

  return rows
    .filter((row) => RANK[row.level as keyof typeof RANK] >= RANK[level])
    // Nobody needs an email about the thing they just did. It is noise, and
    // in a partnership of two it is most of the noise.
    .filter((row) => row.membership_id !== options.except)
    .map(({ membership_id, email, name }) => ({ membership_id, email, name }));
}

/** One message. */
export async function queue(
  trx: Tx,
  kind: OutboxKind,
  to: string,
  rendered: RenderedEmail,
): Promise<void> {
  await trx
    .insertInto('outbox')
    .values({ to_email: to, kind, ...rendered })
    .execute();
}

/** The same message to several people, rendered once each. */
export async function queueAll(
  trx: Tx,
  kind: OutboxKind,
  recipients: Recipient[],
  render: (recipient: Recipient) => RenderedEmail,
): Promise<void> {
  if (recipients.length === 0) return;

  await trx
    .insertInto('outbox')
    .values(
      recipients.map((recipient) => ({
        to_email: recipient.email,
        kind,
        ...render(recipient),
      })),
    )
    .execute();
}

/**
 * A time as the club reads it.
 *
 * §11 asks for time zones to be identified where relevant, and an email about
 * a booking is exactly where it is relevant: the sender has no idea where the
 * reader is, and "Saturday at 09:00" means nothing without saying whose
 * nine. Rendered in the tenant's own zone, with the zone named.
 */
export function inClubTime(when: Date, timezone: string): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when);

  return `${formatted} (${timezone})`;
}
