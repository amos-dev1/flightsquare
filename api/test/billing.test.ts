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

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * §3.7 through the API, and V1_SCOPE M6: statements, not money movement.
 *
 * The assertion that matters most is that raising a rate does not re-price
 * what has already been charged — everything else in this module is in
 * service of a statement nobody can argue with.
 */
describe('member billing', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let club: Awaited<ReturnType<typeof provisionTestTenant>>;
  let free: Awaited<ReturnType<typeof provisionTestTenant>>;
  let pilot: Awaited<ReturnType<typeof addTestMember>>;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    club = await provisionTestTenant('billing');
    free = await provisionTestTenant('billing-free');
    await setPlan(club.tenant_id, 'pro');
    pilot = await addTestMember(club.tenant_id, 'billing-pilot', 'pilot');

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
      payload: {
        registration: 'N6100B',
        type_code: 'C172',
        billing_meter: 'hobbs',
        maintenance_meter: 'tach',
        rate_basis: 'wet',
        // §3.7 rule 3: integer minor units, at the boundary too.
        default_rate_cents: 14000,
        hobbs: '1200.0',
        tach: '1100.0',
      },
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
  function asFreeTenant(): void {
    stub = { sessionId: SESSION_ID, userId: free.user_id, tenantId: free.tenant_id };
  }

  function logFlight(payload: Record<string, unknown>, key: string) {
    return app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': key },
      payload: { aircraft_id: aircraftId, flight_date: '2027-02-14', ...payload },
    });
  }

  it('hides the whole module from a tenant that has nobody to bill', async () => {
    asFreeTenant();
    // §1.6: feature first, so a gated capability is indistinguishable from
    // one that was never built. Not a 402 — the upsell belongs in the UI,
    // reached through entitlement data the client already has.
    expect((await app.inject({ method: 'GET', url: '/statement' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/balances' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/rates' })).statusCode).toBe(404);
  });

  it('charges the flight to whoever flew it, on the billing meter', async () => {
    asAdmin();
    const flown = await logFlight(
      {
        flown_by: pilot.membership_id,
        hobbs_start: '1200.0',
        hobbs_end: '1202.5',
        tach_start: '1100.0',
        tach_end: '1102.0',
      },
      'billing-flight-0001',
    );
    expect(flown.statusCode).toBe(201);

    const statement = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    const charge = statement.json().lines.find((l: { kind: string }) => l.kind === 'charge');

    // Billed on Hobbs — 2.5 hours — not the 2.0 tach hours the engine ran.
    expect(charge.meter).toBe('hobbs');
    expect(charge.meter_hours).toBe('2.5');
    expect(charge.amount_cents).toBe(35000);
    // §3.7 rule 1: the statement says which rule priced it, so it can
    // explain itself without anybody going back to the rate tables.
    expect(charge.rate_source).toBe('aircraft');
    expect(charge.rate_cents).toBe(14000);
  });

  it('credits fuel back on a wet rate', async () => {
    asAdmin();
    await logFlight(
      {
        flown_by: pilot.membership_id,
        hobbs_start: '1202.5',
        hobbs_end: '1203.5',
        fuel_added_qty: '31.4',
        fuel_added_cost_cents: 20410,
      },
      'billing-flight-0002',
    );

    const statement = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    const credit = statement.json().lines.find((l: { kind: string }) => l.kind === 'credit');

    // Negative, so the column adds up without a rule about how to read it.
    expect(credit.amount_cents).toBe(-20410);
    expect(statement.json().credited_cents).toBe(20410);
  });

  it('does not re-price February when the rate goes up in March', async () => {
    asAdmin();
    const before = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    const balanceBefore = before.json().balance_cents;

    const raised = await app.inject({
      method: 'POST',
      url: '/rates',
      payload: { aircraft_id: aircraftId, amount_cents: 15500 },
    });
    expect(raised.statusCode).toBe(201);

    // §3.7 rule 1, the whole reason a charge snapshots rather than joins:
    // "the first the treasurer hears of it is a member disputing a statement
    // they already paid."
    const after = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    expect(after.json().balance_cents).toBe(balanceBefore);
    expect(
      after.json().lines.find((l: { kind: string }) => l.kind === 'charge').rate_cents,
    ).toBe(14000);

    // And the aircraft now quotes the new rate to anybody asking today.
    const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(aircraft.json().default_rate_cents).toBe(15500);
  });

  it('lets a member rate beat the club rate, and says which answered', async () => {
    asAdmin();
    await app.inject({
      method: 'POST',
      url: '/rates',
      payload: {
        aircraft_id: aircraftId,
        membership_id: pilot.membership_id,
        amount_cents: 12500,
      },
    });

    await logFlight(
      { flown_by: pilot.membership_id, hobbs_start: '1203.5', hobbs_end: '1205.5' },
      'billing-flight-0003',
    );

    const statement = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    const latest = statement
      .json()
      .lines.filter((l: { kind: string }) => l.kind === 'charge')
      .at(-1);

    expect(latest.rate_source).toBe('member');
    expect(latest.amount_cents).toBe(25000);
  });

  it('corrects a charge with a reversal rather than an edit', async () => {
    asAdmin();
    const statement = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    const target = statement.json().lines.find((l: { kind: string }) => l.kind === 'charge');
    const balanceBefore = statement.json().balance_cents;

    const reversed = await app.inject({
      method: 'POST',
      url: `/charges/${target.id}/reverse`,
      payload: { reason: 'Hobbs was misread; corrected from the tach' },
    });
    expect(reversed.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    // Both halves stay on the statement — that is what makes it explicable.
    expect(after.json().balance_cents).toBe(balanceBefore - target.amount_cents);
    expect(after.json().lines.find((l: { id: string }) => l.id === target.id).reversed).toBe(
      true,
    );

    // Twice would be a second refund for one mistake.
    const again = await app.inject({
      method: 'POST',
      url: `/charges/${target.id}/reverse`,
      payload: { reason: 'again' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('records a payment as an adjustment, because v1 does not move money', async () => {
    asAdmin();
    const before = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });

    const paid = await app.inject({
      method: 'POST',
      url: '/adjustments',
      payload: {
        membership_id: pilot.membership_id,
        amount_cents: -40000,
        reason: 'Paid $400 by cheque, 3 March',
      },
    });
    expect(paid.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}`,
    });
    expect(after.json().balance_cents).toBe(before.json().balance_cents - 40000);

    // An unexplained line in a ledger is an argument later.
    const unexplained = await app.inject({
      method: 'POST',
      url: '/adjustments',
      payload: { membership_id: pilot.membership_id, amount_cents: -100, reason: '' },
    });
    expect(unexplained.statusCode).toBe(400);
  });

  it('shows a pilot their own ledger and nobody else’s', async () => {
    asPilot();

    // No `member` parameter: their own, which is also the only one the
    // policy would give them (§10 decision 3).
    const mine = await app.inject({ method: 'GET', url: '/statement' });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().membership_id).toBe(pilot.membership_id);
    expect(mine.json().lines.length).toBeGreaterThan(0);

    // Asking for the admin's by name gets them a statement with nothing in
    // it — the rows are simply not there to read, which is the policy doing
    // the work rather than this handler remembering to.
    const theirs = await app.inject({
      method: 'GET',
      url: '/statement?member=' + encodeURIComponent(club.membership_id),
    });
    expect(theirs.json().lines).toHaveLength(0);
    expect(theirs.json().balance_cents).toBe(0);

    // And the treasurer's view is one row: their own.
    const balances = await app.inject({ method: 'GET', url: '/balances' });
    expect(balances.json()).toHaveLength(2);
    const admin = balances
      .json()
      .find((b: { membership_id: string }) => b.membership_id === club.membership_id);
    expect(admin.balance_cents).toBe(0);
  });

  it('puts a flight in the month it was flown, not the month it was typed in', async () => {
    asAdmin();
    // Flown in January, logged now — §8.2's ordinary case, a pilot syncing
    // days later from somewhere with a signal.
    await logFlight(
      {
        flight_date: '2027-01-20',
        flown_by: pilot.membership_id,
        hobbs_start: '1205.5',
        hobbs_end: '1206.5',
      },
      'billing-flight-0004',
    );

    const january = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}&from=2027-01-01&to=2027-01-31`,
    });
    const lines = january.json().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].occurred_on).toBe('2027-01-20');

    // And it is not also on February's, which is the half that would have a
    // treasurer billing the same hour twice.
    const february = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}&from=2027-02-01&to=2027-02-28`,
    });
    expect(
      february.json().lines.some((l: { id: string }) => l.id === lines[0].id),
    ).toBe(false);

    // The reversal is the other way round: it belongs to the day the
    // treasurer noticed, not to the flight, because dating it back would
    // re-write a statement already sent.
    const reversal = await app.inject({
      method: 'POST',
      url: `/charges/${lines[0].id}/reverse`,
      payload: { reason: 'Logged against the wrong member' },
    });
    expect(reversal.statusCode).toBe(201);

    const januaryAgain = await app.inject({
      method: 'GET',
      url: `/statement?member=${pilot.membership_id}&from=2027-01-01&to=2027-01-31`,
    });
    expect(januaryAgain.json().lines).toHaveLength(1);
    expect(januaryAgain.json().lines[0].reversed).toBe(true);
    expect(januaryAgain.json().balance_cents).toBe(january.json().balance_cents);
  });

  it('exports a statement a treasurer can paste somewhere', async () => {
    asAdmin();
    const csv = await app.inject({
      method: 'GET',
      url: `/statement.csv?member=${pilot.membership_id}`,
    });

    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe('date,kind,description,meter,hours,rate,amount,currency');
    // Money as a decimal at the boundary, converted once from minor units.
    expect(csv.body).toMatch(/350\.00/);
    expect(lines.at(-1)).toMatch(/Balance/);
  });
});
