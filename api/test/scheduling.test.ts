import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  addTestMember,
  cleanupTestTenants,
  provisionTestTenant,
  setPlan,
} from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000d0';

/** A Saturday, far enough out that nothing else in the suite wants it. */
const DAY = '2027-05-15';
const at = (hour: number) => `${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * §3.3, through the API.
 *
 * The interesting assertions are all about things the handlers do not do:
 * the constraint refuses the second booking, the triggers refuse the
 * unauthorised pilot and the grounded aeroplane, and the policies refuse
 * somebody else's Saturday. What the handlers do is turn each of those into
 * a sentence.
 */
describe('scheduling', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let club: Awaited<ReturnType<typeof provisionTestTenant>>;
  let pilot: Awaited<ReturnType<typeof addTestMember>>;
  let pilotMembership: string;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    club = await provisionTestTenant('sched');
    await setPlan(club.tenant_id, 'pro');
    pilot = await addTestMember(club.tenant_id, 'sched-pilot', 'pilot');
    pilotMembership = pilot.membership_id;

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
      payload: { registration: 'N4321S', type_code: 'C172' },
    });
    aircraftId = created.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  function asAdmin(): void {
    stub = { sessionId: SESSION_ID, userId: club.user_id, tenantId: club.tenant_id };
  }
  function asPilot(): void {
    stub = { sessionId: SESSION_ID, userId: pilot.user_id, tenantId: club.tenant_id };
  }

  function book(from: number, to: number, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/reservations',
      payload: { aircraft_id: aircraftId, starts_at: at(from), ends_at: at(to), ...extra },
    });
  }

  it('books the aeroplane', async () => {
    asAdmin();
    const response = await book(9, 12, { purpose: 'Local' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      aircraft_registration: 'N4321S',
      purpose: 'Local',
      status: 'booked',
      can_edit: true,
    });
  });

  it('refuses the second person that Saturday, with somewhere to go', async () => {
    asAdmin();
    const clash = await book(11, 14);

    // The exclusion constraint refused it. No SELECT ran here, so there was
    // never a window in which two requests could both find the slot free —
    // which is the whole reason this is a constraint and not a query.
    expect(clash.statusCode).toBe(409);
    expect(clash.json().reason).toMatch(/already booked/i);

    // Back to back is not a clash: the range is half-open.
    expect((await book(12, 15)).statusCode).toBe(201);
  });

  it('will not put a pilot in an aircraft they are not signed off in', async () => {
    asPilot();
    const refused = await book(16, 18);

    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toMatch(/not signed off/i);
  });

  it('lets them book once an admin signs them off', async () => {
    asAdmin();
    const authorized = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/authorizations`,
      payload: { membership_id: pilotMembership, note: 'Checked out 15 May' },
    });
    expect(authorized.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/authorizations`,
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].email).toBe(pilot.email);

    asPilot();
    const booked = await book(16, 18);
    expect(booked.statusCode).toBe(201);
    expect(booked.json().booked_by).toBe(pilotMembership);
  });

  it('keeps one member out of another member’s Saturday', async () => {
    // The admin's morning booking, seen by the pilot.
    asPilot();
    const calendar = await app.inject({ method: 'GET', url: '/reservations' });
    const theirs = calendar.json().find(
      (r: { booked_by: string }) => r.booked_by !== pilotMembership,
    );

    // Every member reads the whole calendar — who has the aeroplane on
    // Saturday is the entire question.
    expect(theirs).toBeDefined();
    expect(theirs.can_edit).toBe(false);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/reservations/${theirs.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(403);

    // Their own, they may have.
    const mine = calendar.json().find(
      (r: { booked_by: string }) => r.booked_by === pilotMembership,
    );
    expect(mine.can_edit).toBe(true);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/reservations/${mine.id}`,
      payload: { notes: 'Taking the long way round' },
    });
    expect(edited.statusCode).toBe(200);
  });

  it('frees the slot on cancellation without losing the booking', async () => {
    asAdmin();
    const calendar = await app.inject({ method: 'GET', url: '/reservations' });
    const morning = calendar.json().find((r: { starts_at: string }) => r.starts_at === at(9));

    const cancelled = await app.inject({
      method: 'POST',
      url: `/reservations/${morning.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');

    // The hours are free again the moment it returns.
    expect((await book(9, 11)).statusCode).toBe(201);

    // §10: cancelling is a status. It is off the calendar, not out of the
    // record — a club arguing about a Saturday needs it to still be there.
    const after = await app.inject({ method: 'GET', url: '/reservations' });
    expect(after.json().some((r: { id: string }) => r.id === morning.id)).toBe(false);
  });

  it('holds the hours for an annual, and will not schedule one over a booking', async () => {
    asAdmin();
    const clash = await app.inject({
      method: 'POST',
      url: '/blackouts',
      payload: {
        aircraft_id: aircraftId,
        reason: 'Annual inspection',
        starts_at: at(9),
        ends_at: at(11),
      },
    });
    // Somebody is flying then. Telling them is a phone call, not a trigger.
    expect(clash.statusCode).toBe(409);
    expect(clash.json().reason).toMatch(/cancel the booking first/i);

    const blackout = await app.inject({
      method: 'POST',
      url: '/blackouts',
      payload: {
        aircraft_id: aircraftId,
        reason: 'Annual inspection',
        starts_at: `${DAY}T20:00:00.000Z`,
        ends_at: `${DAY}T23:00:00.000Z`,
      },
    });
    expect(blackout.statusCode).toBe(201);

    const refused = await book(21, 22);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toMatch(/already booked/i);
  });

  it('stops new bookings when the aircraft is grounded, and flags the old ones', async () => {
    asAdmin();
    await app.inject({
      method: 'POST',
      url: '/squawks',
      headers: { 'idempotency-key': 'sched-grounding-0001' },
      payload: {
        aircraft_id: aircraftId,
        summary: 'Left brake soft',
        severity: 'grounding',
      },
    });

    const refused = await book(6, 8);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toMatch(/not available/i);

    // §3.3: the ones already on the calendar are somebody's Saturday. They
    // are flagged so the club can call those members — never cancelled by
    // something that has no idea what else was arranged around them.
    const calendar = await app.inject({ method: 'GET', url: '/reservations' });
    const flagged = calendar.json().filter((r: { needs_review: boolean }) => r.needs_review);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].status).toBe('booked');
    expect(flagged[0].review_reason).toMatch(/Left brake soft/);

    // The admin makes the call and clears it.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/reservations/${flagged[0].id}`,
      payload: { needs_review: false },
    });
    expect(cleared.json().needs_review).toBe(false);
    expect(cleared.json().review_reason).toBeNull();
  });

  it('answers "what have I got coming up"', async () => {
    asPilot();
    const mine = await app.inject({ method: 'GET', url: '/reservations?mine=true' });

    expect(mine.statusCode).toBe(200);
    expect(mine.json().length).toBeGreaterThan(0);
    expect(
      mine.json().every((r: { booked_by: string }) => r.booked_by === pilotMembership),
    ).toBe(true);
  });
});
