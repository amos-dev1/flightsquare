import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000b0';
let keyCounter = 0;
const nextKey = () => `vitest-idem-${Date.now()}-${keyCounter++}`;

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('flight logging', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    tenant = await provisionTestTenant('flights');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();

    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };

    const created = await app.inject({
      method: 'POST',
      url: '/aircraft',
      payload: { registration: 'N7642G', type_code: 'C172', home_base: 'KPAO' },
    });
    aircraftId = created.json().id;

    // A known starting point, so the gap test has something to be a gap from.
    await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/meter-readings`,
      payload: { hobbs: '1200.0', tach: '1100.0', airframe_hours: '1200.0' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function logFlight(payload: Record<string, unknown>, key = nextKey()) {
    return app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': key },
      payload: { aircraft_id: aircraftId, flight_date: '2026-09-20', ...payload },
    });
  }

  it('advances the meters, without being asked to', async () => {
    const response = await logFlight({
      hobbs_start: '1200.0',
      hobbs_end: '1202.3',
      tach_start: '1100.0',
      tach_end: '1102.0',
      departed_from: 'KPAO',
      arrived_at: 'KTRK',
    });

    expect(response.statusCode).toBe(201);
    const flight = response.json();
    expect(flight.flight_date).toBe('2026-09-20');
    expect(flight.needs_review).toBe(false);
    // Recorded as read, neither derived from the other: 2.3 Hobbs, 2.0 tach.
    expect(flight.hobbs_hours).toBe('2.3');
    expect(flight.tach_hours).toBe('2.0');

    // Nothing in this test posted a meter reading for the flight.
    const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(aircraft.json().hobbs).toBe('1202.3');
    expect(aircraft.json().tach).toBe('1102.0');
  });

  it('flags a meter gap and records the flight anyway', async () => {
    // §8.2: the gap is real information — usually a maintenance run or an
    // unlogged flight — so refusing the entry would discard it along with
    // the flight nobody would then bother to log.
    const response = await logFlight({
      hobbs_start: '1202.7',
      hobbs_end: '1204.0',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().needs_review).toBe(true);
    expect(response.json().review_reason).toMatch(/1202\.7.*1202\.3/);

    const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(aircraft.json().hobbs).toBe('1204.0');

    const flagged = await app.inject({ method: 'GET', url: '/flights?needs_review=true' });
    expect(flagged.json()).toHaveLength(1);
  });

  it('keeps fuel state and fuel spend apart', async () => {
    const response = await logFlight({
      hobbs_start: '1204.0',
      hobbs_end: '1205.5',
      fuel_remaining_after: '22.5',
      fuel_added_qty: '31.4',
      fuel_added_cost_cents: 20410,
    });

    const flight = response.json();
    // State: what the next pilot is walking out to.
    expect(flight.fuel_remaining_after).toBe('22.5');
    // Transaction: what someone spent, in integer minor units (§3.7 rule 3).
    expect(flight.fuel_added_qty).toBe('31.4');
    expect(flight.fuel_added_cost_cents).toBe(20410);
    expect(flight.currency).toBe('USD');
  });

  it('records a flight with no fuel entry at all', async () => {
    const response = await logFlight({ hobbs_start: '1205.5', hobbs_end: '1206.0' });
    expect(response.statusCode).toBe(201);
    expect(response.json().fuel_remaining_after).toBeNull();
  });

  describe('idempotency', () => {
    it('returns the first response, and logs the flight once', async () => {
      const key = nextKey();
      const payload = { hobbs_start: '1206.0', hobbs_end: '1207.1' };

      const before = (await app.inject({ method: 'GET', url: '/flights' })).json().length;
      const first = await logFlight(payload, key);
      const replay = await logFlight(payload, key);

      expect(first.statusCode).toBe(201);
      // 200, not 201: the flight was created once, and saying so twice
      // would be a lie.
      expect(replay.statusCode).toBe(200);
      expect(replay.json().id).toBe(first.json().id);

      const after = (await app.inject({ method: 'GET', url: '/flights' })).json();
      expect(after.length).toBe(before + 1);

      // And the meters advanced once, which is the failure that matters:
      // a doubled flight would put every countdown downstream out by one.
      const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
      expect(aircraft.json().hobbs).toBe('1207.1');
    });

    it('refuses a key reused for a different request', async () => {
      const key = nextKey();
      await logFlight({ hobbs_start: '1207.1', hobbs_end: '1208.0' }, key);
      const different = await logFlight({ hobbs_start: '1207.1', hobbs_end: '1209.0' }, key);

      // Not a retry — a client bug, and telling it so beats silently
      // returning somebody else's answer.
      expect(different.statusCode).toBe(409);
    });

    it('requires a key at all', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/flights',
        payload: { aircraft_id: aircraftId, flight_date: '2026-09-20', hobbs_end: '1210.0' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/idempotency-key/i);
    });
  });

  it('refuses a flight that advanced no meter, and says why', async () => {
    // Advancing the meters is what a flight record is *for*. The database
    // enforces it as well, but a CHECK violation arriving as a 500 tells the
    // person standing at the tiedown nothing about what to fix.
    const response = await logFlight({ hobbs_start: '1208.0', remarks: 'taxi test' });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/ending Hobbs or tach/i);
  });

  it('exports the caller’s own rows as CSV, and nothing more', async () => {
    const response = await app.inject({ method: 'GET', url: '/flights/export.csv' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment/);

    const [header, ...rows] = response.body.trim().split('\n');
    expect(header).toBe(
      'date,aircraft,from,to,hobbs_start,hobbs_end,hobbs_hours,tach_start,tach_end,tach_hours,remarks',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toContain('N7642G');

    // A calendar day, not an instant. pg parses a `date` into a JS Date by
    // default, which attaches a timezone to something that never had one and
    // can shift the day across a boundary for the reader.
    expect(rows[0]!.split(',')[0]).toBe('2026-09-20');

    // §3.4 draws a line here: the export is the whole pilot-logbook story.
    // No totals, no currency, no landings, no endorsements.
    expect(header).not.toMatch(/total|currency|landing|approach|endorsement/i);
  });

  it('is never capped, on any tier', async () => {
    // §4.2: a tenant that hit a monthly cap would stop logging, the meters
    // would go stale, and every maintenance number would quietly go wrong.
    const entitlements = await app.inject({ method: 'GET', url: '/entitlements' });
    const quotas = Object.keys(entitlements.json().quotas);
    expect(quotas.filter((q) => q.startsWith('flight'))).toEqual([]);
  });

  it('accepts a field the reference table has never heard of', async () => {
    // `aerodromes` holds twenty rows; there are twenty thousand airfields in
    // the United States. A key against a list that incomplete refuses almost
    // every true answer, and it refused them on the one screen §3.4 says
    // must never be awkward — a flight to a real airport fifteen minutes
    // away was a 500 until 0014 dropped it.
    const response = await logFlight({
      hobbs_start: '9000.0',
      hobbs_end: '9000.6',
      departed_from: 'Q22',
      arrived_at: 'PRIVATE STRIP',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().arrived_at).toBe('PRIVATE STRIP');
  });
});
