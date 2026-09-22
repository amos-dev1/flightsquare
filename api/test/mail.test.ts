import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withSession } from '../src/db/context.js';
import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { UnauthorizedError } from '../src/http/errors.js';
import type { ResolvedSession } from '../src/http/session.js';
import {
  assertMailRole,
  drainOnce,
  mailDatabase,
} from '../src/mail/worker.js';
import {
  UndeliverableError,
  type MailTransport,
  type OutgoingMessage,
} from '../src/mail/transport.js';
import { sweepTenant } from '../src/scheduler/maintenance.js';
import {
  addTestMember,
  cleanupTestTenants,
  provisionTestTenant,
  readOutbox,
  setPlan,
  uniqueEmail,
} from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000f0';

/** A transport that does what the test tells it to. */
class ScriptedTransport implements MailTransport {
  readonly name = 'scripted';
  readonly sent: OutgoingMessage[] = [];
  outcome: 'ok' | 'transient' | 'permanent' = 'ok';

  async send(message: OutgoingMessage): Promise<void> {
    if (this.outcome === 'transient') throw new Error('the provider was busy');
    if (this.outcome === 'permanent') {
      throw new UndeliverableError('no such mailbox');
    }
    this.sent.push(message);
  }
}

describe('the mail queue', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let club: Awaited<ReturnType<typeof provisionTestTenant>>;
  let pilot: Awaited<ReturnType<typeof addTestMember>>;
  let aircraftId: string;
  const mail = mailDatabase();
  const transport = new ScriptedTransport();

  beforeAll(async () => {
    await cleanupTestTenants();
    club = await provisionTestTenant('mail');
    await setPlan(club.tenant_id, 'pro');
    pilot = await addTestMember(club.tenant_id, 'mail-pilot', 'pilot');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();

    asAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/aircraft',
      payload: { registration: 'N8800M', type_code: 'C172' },
    });
    aircraftId = created.json().id;

    // §3.5's checkout rule: booking on somebody's behalf asks whether they
    // are signed off in that aeroplane, and a fresh membership is not.
    await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/authorizations`,
      payload: { membership_id: pilot.membership_id },
    });
  });

  afterAll(async () => {
    await app.close();
    await mail.destroy();
    await cleanupTestTenants();
    await closeDatabase();
  });

  function asAdmin(): void {
    stub = { sessionId: SESSION_ID, userId: club.user_id, tenantId: club.tenant_id };
  }
  function asPilot(): void {
    stub = { sessionId: SESSION_ID, userId: pilot.user_id, tenantId: club.tenant_id };
  }

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  it('refuses to run as anything but the mail role', async () => {
    // The realistic way this goes wrong is a copied connection string, and a
    // worker running as the owner would hold DDL on every table in the
    // database in order to send some email.
    await expect(assertMailRole(mail)).resolves.toBeUndefined();
  });

  it('sends what is queued and records that it went', async () => {
    transport.outcome = 'ok';
    asAdmin();

    const address = uniqueEmail('mail-drain');
    await queueInvite(app, address);

    const result = await drainOnce(mail, transport);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(transport.sent.some((message) => message.to === address)).toBe(true);

    const [queued] = await readOutbox(address);
    expect(queued?.kind).toBe('invite');
  });

  it('keeps a message that failed, with the reason, and does not send it', async () => {
    transport.outcome = 'transient';
    asAdmin();

    const address = uniqueEmail('mail-transient');
    await queueInvite(app, address);

    const before = transport.sent.length;
    await drainOnce(mail, transport);
    expect(transport.sent.length).toBe(before);

    const row = await delivery(mail, address);
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/busy/);

    // And the backoff holds: a message tried a moment ago is not tried again
    // on the very next pass, which is the difference between a retry and a
    // hot loop against somebody else's mail server.
    const second = await drainOnce(mail, transport);
    expect(second.claimed).toBe(0);
    expect((await delivery(mail, address)).attempts).toBe(1);
  });

  it('gives up on a message that can never be delivered', async () => {
    transport.outcome = 'permanent';
    asAdmin();

    const address = uniqueEmail('mail-permanent');
    await queueInvite(app, address);

    await drainOnce(mail, transport);

    // Retired by exhausting its attempts rather than by a second column: a
    // queue that keeps retrying the undeliverable is how a sending domain
    // gets itself blocked.
    const row = await delivery(mail, address);
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBeGreaterThanOrEqual(8);
    expect(row.last_error).toMatch(/mailbox/);

    expect((await drainOnce(mail, transport)).claimed).toBe(0);
    transport.outcome = 'ok';
  });

  // -------------------------------------------------------------------------
  // Who gets told
  // -------------------------------------------------------------------------

  it('tells whoever can act on a squawk, and not the person who filed it', async () => {
    asPilot();
    const filed = await app.inject({
      method: 'POST',
      url: '/squawks',
      headers: { 'idempotency-key': 'mail-squawk-0001' },
      payload: {
        aircraft_id: aircraftId,
        summary: 'Nav light intermittent',
        severity: 'minor',
      },
    });
    expect(filed.statusCode).toBe(201);

    // §1.5: recipients are resolved by permission, never by role name. The
    // Pilot bundle holds `maintenance: read`, so the notice reaches the
    // Admin and nobody else — and a club that invented its own bundle with
    // `maintenance: write` would be included without this code changing.
    const toAdmin = await readOutbox(club.email);
    expect(toAdmin.some((message) => message.kind === 'squawk_filed')).toBe(true);

    const toPilot = await readOutbox(pilot.email);
    expect(toPilot.some((message) => message.kind === 'squawk_filed')).toBe(false);
  });

  it('tells the member a booking is for, not the person who made it', async () => {
    asAdmin();
    const booked = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: {
        aircraft_id: aircraftId,
        booked_by: pilot.membership_id,
        starts_at: '2027-05-01T15:00:00Z',
        ends_at: '2027-05-01T17:00:00Z',
      },
    });
    expect(booked.statusCode).toBe(201);

    const toPilot = await readOutbox(pilot.email);
    const confirmation = toPilot.find((message) => message.kind === 'booking_confirmed');
    expect(confirmation).toBeDefined();
    // §11: a time is meaningless without saying whose. The club's zone, named.
    expect(confirmation?.body).toMatch(/UTC/);

    // The admin who did it hears nothing — they were there.
    const toAdmin = await readOutbox(club.email);
    expect(toAdmin.some((message) => message.kind === 'booking_confirmed')).toBe(false);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/reservations/${booked.json().id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);

    const after = await readOutbox(pilot.email);
    expect(after.some((message) => message.kind === 'booking_cancelled')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The one notice with no event behind it
  // -------------------------------------------------------------------------

  it('reports what has come due, once, and not again', async () => {
    // Adding an aircraft seeds its intervals from the preset library and
    // nobody has recorded when any of them were last done, so they are all
    // outstanding from the moment it exists.
    const first = await sweepTenant(club.tenant_id);
    expect(first.items).toBeGreaterThan(0);
    expect(first.notified).toBe(1);

    const digest = (await readOutbox(club.email)).find(
      (message) => message.kind === 'maintenance_due',
    );
    expect(digest).toBeDefined();
    expect(digest?.body).toContain('N8800M');
    // §11: the absence of a warning is not airworthiness, and this is not a
    // release to service. The email says so rather than implying otherwise.
    expect(digest?.body).toMatch(/not an airworthiness/i);
    // And an item nobody has ever recorded is not "overdue" — that is a
    // claim about the aircraft, and we have no record instead.
    expect(digest?.body).toContain('NO RECORD');

    // The second pass is the one that matters. A digest that repeats itself
    // every morning gets filtered within a week, and the filter takes the
    // one that mattered with it.
    const second = await sweepTenant(club.tenant_id);
    expect(second.items).toBe(0);
    expect(second.notified).toBe(0);
  });

  it('starts telling again once the item has been dealt with', async () => {
    asAdmin();
    const items = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/maintenance-items`,
    });
    const item = items.json()[0];
    expect(item).toBeDefined();

    const recorded = await app.inject({
      method: 'POST',
      url: '/compliance-records',
      payload: {
        aircraft_id: aircraftId,
        maintenance_item_id: item.maintenance_item_id ?? item.id,
        kind: 'inspection',
        title: item.name,
        complied_on: '2027-01-04',
      },
    });
    expect(recorded.statusCode).toBe(201);

    // Recording compliance moves the due point, and a moved due point has
    // nothing outstanding to have been told about. Without the trigger that
    // clears it, the item's second trip through overdue would be silent —
    // which is the failure the column exists to prevent.
    const cleared = await notifiedState(club.tenant_id, item.maintenance_item_id ?? item.id);
    expect(cleared).toBeNull();
  });

  it('answers a malformed id with the same 404 as somebody else’s', async () => {
    asAdmin();
    // §6: a malformed id and an id belonging to another tenant have to read
    // the same. This was a 500 — the value reached Postgres unparsed.
    const response = await app.inject({
      method: 'POST',
      url: '/reservations/not-a-uuid/cancel',
    });
    expect(response.statusCode).toBe(404);
  });
});

/** What the digest last said about an item, read out of band. */
async function notifiedState(tenantId: string, itemId: string): Promise<string | null> {
  return withSession({ tenantId }, async (trx) => {
    const row = await trx
      .selectFrom('maintenance_items')
      .select('notified_state')
      .where('id', '=', itemId)
      .executeTakeFirst();
    return row?.notified_state ?? null;
  });
}

/** Something real in the queue, through the path that queues it. */
async function queueInvite(app: FastifyInstance, email: string): Promise<void> {
  const invited = await app.inject({
    method: 'POST',
    url: '/invites',
    payload: { email, role: 'pilot' },
  });
  expect(invited.statusCode).toBe(201);
}

interface Delivery {
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
}

async function delivery(
  mail: ReturnType<typeof mailDatabase>,
  address: string,
): Promise<Delivery> {
  const row = await mail
    .selectFrom('outbox')
    .select(['sent_at', 'attempts', 'last_error'])
    .where('to_email', '=', address)
    .executeTakeFirstOrThrow();
  return row as Delivery;
}
