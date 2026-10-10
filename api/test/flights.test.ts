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

  it('separates the whole club\u2019s flights from this pilot\u2019s own', async () => {
    // A club's flights are shared by design — §4.4 gives everyone `flights`
    // at scope `all`, because who flew what is how the meters and the money
    // reconcile. So `mine` is a filter, not a permission, and until it
    // existed there was no way to ask the question at all.
    await setPlan(tenant.tenant_id, 'pro');
    const other = await addTestMember(tenant.tenant_id, 'flights-other', 'pilot');

    await logFlight({
      flown_by: other.membership_id,
      hobbs_start: '9500.0',
      hobbs_end: '9501.0',
    });

    const everything = await app.inject({ method: 'GET', url: '/flights' });
    const mine = await app.inject({ method: 'GET', url: '/flights?mine=true' });

    expect(everything.json().length).toBeGreaterThan(mine.json().length);
    expect(
      mine.json().every((flight: { flown_by: string }) => flight.flown_by !== other.membership_id),
    ).toBe(true);

    // And the export stays own-only by construction, whatever the list is
    // filtered to — §3.4 is explicit that the export is the whole of the
    // pilot-logbook story, and somebody else's flights are not part of it.
    const csv = await app.inject({ method: 'GET', url: '/flights/export.csv' });
    expect(csv.body.split('\n').length - 1).toBe(mine.json().length + 1);
  });

  it('adds the flights up on the server, because the client must not', async () => {
    // §8.2: the client never computes anything that matters, and a headline
    // number on a dashboard matters. `GET /flights` also caps at 200 rows,
    // so a client-side sum is wrong past that in the direction nobody
    // notices — which is the whole reason this endpoint exists.
    const all = await app.inject({ method: 'GET', url: '/flights' });
    const summary = await app.inject({ method: 'GET', url: '/flights/summary' });

    expect(summary.statusCode).toBe(200);
    expect(summary.json().flights).toBe(all.json().length);

    // Both meters, neither derived from the other (§3.4). Hours are strings
    // because they are `numeric`, and a float round-trip is how a
    // maintenance countdown drifts.
    const hobbs = all
      .json()
      .reduce((total: number, f: { hobbs_hours: string | null }) => total + Number(f.hobbs_hours ?? 0), 0);
    expect(Number(summary.json().hobbs_hours)).toBeCloseTo(hobbs, 1);
    expect(summary.json().tach_hours).toBeDefined();
    expect(summary.json().first_flight_date).not.toBeNull();

    // Narrowed the same ways the list is, because it is the same question.
    const mine = await app.inject({ method: 'GET', url: '/flights/summary?mine=true' });
    const mineList = await app.inject({ method: 'GET', url: '/flights?mine=true' });
    expect(mine.json().flights).toBe(mineList.json().length);
    expect(mine.json().flights).toBeLessThan(summary.json().flights);

    const perAircraft = await app.inject({
      method: 'GET',
      url: `/flights/summary?aircraft_id=${aircraftId}`,
    });
    expect(perAircraft.json().flights).toBeGreaterThan(0);

    // An aeroplane with nothing logged answers zero, not null. "None yet" is
    // an answer; "we could not tell you" is a different one, and only one of
    // them belongs on a dashboard.
    const empty = await app.inject({
      method: 'GET',
      url: '/flights/summary?aircraft_id=01920000-0000-7000-8000-00000000dead',
    });
    expect(empty.json()).toMatchObject({
      flights: 0,
      hobbs_hours: '0',
      tach_hours: '0',
      first_flight_date: null,
      last_flight_date: null,
    });
  });

  it('returns one flight in full, and 404s the ones that are not yours', async () => {
    const list = await app.inject({ method: 'GET', url: '/flights' });
    const wanted = list.json()[0];

    const one = await app.inject({ method: 'GET', url: `/flights/${wanted.id}` });
    expect(one.statusCode).toBe(200);
    // The same projection as the list, so a detail screen and a row can
    // never disagree about a meter.
    expect(one.json()).toEqual(wanted);

    // Both meters travel, neither derived from the other (§3.4).
    expect(one.json()).toHaveProperty('hobbs_start');
    expect(one.json()).toHaveProperty('tach_hours');

    // A static segment still wins over the parameter, whatever order they
    // were registered in — otherwise this route would have eaten both.
    const summary = await app.inject({ method: 'GET', url: '/flights/summary' });
    expect(summary.json()).toHaveProperty('flights');
    const csv = await app.inject({ method: 'GET', url: '/flights/export.csv' });
    expect(csv.headers['content-type']).toContain('text/csv');

    // §6: errors do not leak cross-tenant existence. A flight nobody here can
    // see is missing, not forbidden — and a malformed id is the same answer
    // rather than a 500 from the driver.
    const absent = await app.inject({
      method: 'GET',
      url: '/flights/01920000-0000-7000-8000-00000000dead',
    });
    expect(absent.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/flights/not-a-uuid' });
    expect(malformed.statusCode).toBe(404);
  });

  it('works the fuel total out from the pump price, because a client must not', async () => {
    // §8.2: the client never computes anything that matters, and §3.7 rule 3
    // keeps money in integer minor units. A pilot reads a price off the pump
    // and a quantity off the truck; multiplying them is the server's job
    // because the answer is a charge.
    const response = await logFlight({
      hobbs_start: '9100.0',
      hobbs_end: '9101.0',
      fuel_added_qty: '18.4',
      fuel_price_cents: 689,
    });

    expect(response.statusCode).toBe(201);
    // 689 x 18.4 = 12677.6, to the nearest cent.
    expect(response.json().fuel_added_cost_cents).toBe(12678);
    expect(response.json().fuel_price_cents).toBe(689);
  });

  it('lets a receipt beat the arithmetic', async () => {
    // Somebody copying a total off a receipt knows it better than a
    // multiplication does — rounding, a discount, a call-out fee.
    const response = await logFlight({
      hobbs_start: '9200.0',
      hobbs_end: '9201.0',
      fuel_added_qty: '20.0',
      fuel_price_cents: 700,
      fuel_added_cost_cents: 13500,
    });

    expect(response.json().fuel_added_cost_cents).toBe(13500);
  });

  it('records what was in the tanks at start-up, and what the flight was for', async () => {
    const response = await logFlight({
      hobbs_start: '9300.0',
      hobbs_end: '9301.5',
      fuel_remaining_before: '41.0',
      fuel_remaining_after: '32.5',
      category: 'maintenance',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().fuel_remaining_before).toBe('41.0');
    expect(response.json().fuel_remaining_after).toBe('32.5');
    expect(response.json().category).toBe('maintenance');

    // Descriptive only. §3.7 keeps charges append-only and snapshotting their
    // rate, so a category that quietly suppressed one would be a billing rule
    // arriving through a dropdown. Categorising a flight changes nothing about
    // what it cost.
    const list = await app.inject({ method: 'GET', url: '/flights' });
    const logged = list.json().find((f: { id: string }) => f.id === response.json().id);
    expect(logged.category).toBe('maintenance');
  });

  it('refuses a category it has never heard of', async () => {
    const response = await logFlight({
      hobbs_start: '9400.0',
      hobbs_end: '9401.0',
      category: 'ferry',
    });

    expect(response.statusCode).toBe(400);
  });

  it('takes the id the device minted, so an offline squawk can name it', async () => {
    // §8.2: "the client generates ids". The phone files a flight and a squawk
    // on the same walk back from the aeroplane, and the squawk has to name a
    // flight neither of them has sent yet.
    const id = '01a0d000-0000-7000-8000-00000000f11d';
    const response = await logFlight({ id, hobbs_start: '9500.0', hobbs_end: '9501.0' });

    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe(id);

    const squawk = await app.inject({
      method: 'POST',
      url: '/squawks',
      headers: { 'idempotency-key': nextKey() },
      payload: { aircraft_id: aircraftId, summary: 'Left brake soft', found_on_flight_id: id },
    });
    expect(squawk.statusCode).toBe(201);
    expect(squawk.json().found_on_flight_id).toBe(id);
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

  /**
   * §3.4: nothing is edited, so a correction is a new flight replacing an old
   * one. The rule about *who* may is proved in `db/tests/190`, where it
   * lives; these are the things only the API can get wrong.
   */
  describe('corrections', () => {
    it('replaces a flight, and the reads stop counting the old one', async () => {
      const before = await app.inject({ method: 'GET', url: `/flights/summary?aircraft_id=${aircraftId}` });
      const hoursBefore = Number(before.json().hobbs_hours);
      const countBefore = Number(before.json().flights);

      const at = Number(
        (await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` })).json().hobbs,
      );
      const wrong = await logFlight({
        hobbs_start: at.toFixed(1),
        hobbs_end: (at + 10).toFixed(1),
        arrived_at: 'KPWK',
      });
      expect(wrong.statusCode).toBe(201);

      const right = await logFlight({
        hobbs_start: at.toFixed(1),
        hobbs_end: (at + 2).toFixed(1),
        arrived_at: 'KUGN',
        supersedes_id: wrong.json().id,
        correction_reason: 'Hobbs misread on the panel',
      });
      expect(right.statusCode).toBe(201);

      // Not flagged: the comparison runs against what the aeroplane read
      // *before* the flight being corrected, not against the wrong figure.
      expect(right.json().needs_review).toBe(false);

      const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
      expect(aircraft.json().hobbs).toBe((at + 2).toFixed(1));
      // These two are live subqueries over the latest flight with no trigger
      // behind them, so they are the ones a correction could silently miss.
      expect(aircraft.json().last_location).toBe('KUGN');

      const after = await app.inject({ method: 'GET', url: `/flights/summary?aircraft_id=${aircraftId}` });
      expect(Number(after.json().hobbs_hours) - hoursBefore).toBe(2);
      expect(Number(after.json().flights) - countBefore).toBe(1);

      // The list keeps both and says which is which: the history is the point.
      const list = await app.inject({ method: 'GET', url: `/flights?aircraft_id=${aircraftId}` });
      const rows = list.json() as { id: string; superseded_by: string | null; correction_reason: string | null }[];
      expect(rows.find((r) => r.id === wrong.json().id)?.superseded_by).toBe(right.json().id);
      expect(rows.find((r) => r.id === right.json().id)?.correction_reason).toBe(
        'Hobbs misread on the panel',
      );

      // §3.4's logbook export is what somebody transcribes onto paper, so the
      // line that was wrong is not in it.
      const exported = await app.inject({ method: 'GET', url: '/flights/export.csv' });
      expect(exported.body).not.toContain('KPWK');
      expect(exported.body).toContain('KUGN');
    });

    it('refuses to correct the same flight twice', async () => {
      const flight = await logFlight({ hobbs_start: '1208.0', hobbs_end: '1209.0' });
      const first = await logFlight({
        hobbs_start: '1208.0',
        hobbs_end: '1209.5',
        supersedes_id: flight.json().id,
        correction_reason: 'The first correction',
      });
      expect(first.statusCode).toBe(201);

      const second = await logFlight({
        hobbs_start: '1208.0',
        hobbs_end: '1209.6',
        supersedes_id: flight.json().id,
        correction_reason: 'The second correction',
      });
      // Correcting twice is not twice as corrected — the next one supersedes
      // the correction, so the history stays a chain.
      expect(second.statusCode).toBe(409);
      expect(second.json().reason).toMatch(/already been corrected/);
    });

    it('answers 404 for a flight it cannot see, the same as one that never existed', async () => {
      const response = await logFlight({
        hobbs_start: '1209.5',
        hobbs_end: '1210.0',
        supersedes_id: '01920000-0000-7000-8000-00000000dead',
        correction_reason: 'Correcting nothing at all',
      });
      // §6: an error never leaks cross-tenant existence, so the two cases
      // have to be indistinguishable.
      expect(response.statusCode).toBe(404);
    });

    it('takes a flight back without claiming a reading nobody took', async () => {
      const flight = await logFlight({ hobbs_start: '1209.5', hobbs_end: '1211.0' });
      expect(flight.statusCode).toBe(201);

      const gone = await logFlight({
        supersedes_id: flight.json().id,
        correction_reason: 'Entered twice from the phone',
        logged_in_error: true,
      });
      // No meters at all, which is the whole content of the claim — and the
      // only request this endpoint accepts without an ending reading.
      expect(gone.statusCode).toBe(201);
      expect(gone.json().hobbs_end).toBeNull();

      const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
      expect(aircraft.json().hobbs).toBe('1209.5');
    });

    it('will not take a correction without a reason', async () => {
      const flight = await logFlight({ hobbs_start: '1209.5', hobbs_end: '1212.0' });
      const response = await logFlight({
        hobbs_start: '1209.5',
        hobbs_end: '1213.0',
        supersedes_id: flight.json().id,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/reason/);
    });
  });

});
