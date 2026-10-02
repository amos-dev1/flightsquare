import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, db } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { addTestMember, cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';
import { withTenant } from '../src/db/context.js';
import { previewRules } from '../src/maintenance/intervals.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000d0';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * The loop, end to end through the API:
 *
 *   flight logged -> meters advance -> items tick down
 *      -> overdue, or a grounding squawk
 *      -> availability says no
 *
 * and the permission line §1.5 calls the one that is expensive to recover:
 * a pilot files a squawk and cannot close it.
 */
describe('maintenance', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;
  let other: Awaited<ReturnType<typeof provisionTestTenant>>;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    tenant = await provisionTestTenant('maint-a');
    other = await provisionTestTenant('maint-b');

    // §4.4 is enforced by a trigger now: a club keeps one member who can
    // manage members. This suite demotes its own membership to Pilot to test
    // the §1.5 line, so the club needs a second Admin to still be a club
    // afterwards.
    await addTestMember(tenant.tenant_id, 'maint-spare-admin', 'admin');

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
      payload: { registration: 'N123AB', type_code: 'C172', maintenance_meter: 'tach' },
    });
    aircraftId = created.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  function asAdmin(): void {
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
  }
  function asOtherTenant(): void {
    stub = { sessionId: SESSION_ID, userId: other.user_id, tenantId: other.tenant_id };
  }

  /**
   * The account creator is the only member, and they are an Admin (§4.4).
   * Demoting them to the Pilot bundle is how this suite gets somebody who is
   * deliberately not allowed to do everything — the role is data, so this is
   * an UPDATE rather than a code path.
   */
  async function setBundle(code: 'admin' | 'pilot'): Promise<void> {
    await withTenant({ tenantId: tenant.tenant_id, userId: tenant.user_id }, async (trx) => {
      const bundle = await trx
        .selectFrom('role_bundles')
        .select('id')
        .where('code', '=', code)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('memberships')
        .set({ role_bundle_id: bundle.id })
        .where('id', '=', tenant.membership_id)
        .execute();
    });
  }

  /**
   * Instantiate the preset library on the suite's aircraft.
   *
   * Explicit since Phase 1D, where SPEC §1's "empty by default" replaced
   * seeding on aircraft creation. Idempotent, so tests that both want presets
   * do not fight.
   */
  async function seedFromLibrary(): Promise<void> {
    const seeded = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/maintenance-items/from-library`,
    });
    expect(seeded.statusCode).toBe(200);
  }

  async function items() {
    const response = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/maintenance-items`,
    });
    return response.json() as Array<Record<string, never>>;
  }

  function find(list: Array<Record<string, unknown>>, template: string) {
    return list.find((row) => row.template_code === template)!;
  }

  it('tracks nothing on a new aircraft until somebody says so', async () => {
    /*
      SPEC §1: "Empty by default. A new aircraft has zero tracked items."

      This assertion is inverted from what it said until Phase 1D, and the
      argument that changed it is better than the one it replaced. Items nobody
      approved are the app asserting obligations it cannot know apply — a
      100-hour on a private aeroplane, an ELT inspection on one with no ELT —
      and every seeded item arrives due today with no compliance behind it, so a
      brand-new aircraft used to open on a screen full of red.
    */
    asAdmin();
    // The suite's own aircraft, created in beforeAll and not touched since.
    // This has to be the first assertion in the file, because it is the only
    // moment the aeroplane is as a real one would be on the day it is added —
    // and the free tier's one-aircraft quota means there is no second one to
    // make the point with.
    expect(await items()).toEqual([]);
  });

  it('seeds the applicable presets when asked, and invents nothing', async () => {
    asAdmin();
    // The library is still there; it is a choice now rather than a default,
    // and Phase 3 turns it into the suggestions inbox it was shaped for.
    await seedFromLibrary();
    const list = await items();

    expect(list.map((row: Record<string, unknown>) => row.template_code).sort()).toEqual([
      'annual',
      'elt_battery',
      'elt_inspection',
      'oil_change',
      'pitot_static',
      'transponder',
    ]);

    // 91.409(b) requires a 100-hour only for hire or instruction. Seeding one
    // onto a private aeroplane would invent an inspection the FAA never asked
    // for, and then ground the aircraft over it.
    expect(list.some((row: Record<string, unknown>) => row.template_code === '100_hour'))
      .toBe(false);

    // And every one arrives with the rules that make it count down (0026).
    const annual = list.find((row: Record<string, unknown>) => row.template_code === 'annual');
    expect((annual as unknown as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('says "not recorded" rather than claiming the aircraft is in annual', async () => {
    asAdmin();
    const annual = find(await items(), 'annual');

    // §11: do not infer "Airworthy" from the absence of a warning. Nobody has
    // told us when the last annual was, so nothing here pretends to know.
    expect(annual.ever_complied).toBe(false);
    expect(annual.last_complied_on).toBeNull();
    expect(annual.state).toBe('due_soon');
    expect(annual.template_version).toBe(1);
  });

  it('rolls an item forward by calendar months when compliance is recorded', async () => {
    asAdmin();
    const annual = find(await items(), 'annual');

    const response = await app.inject({
      method: 'POST',
      url: '/compliance-records',
      payload: {
        aircraft_id: aircraftId,
        maintenance_item_id: annual.id,
        kind: 'inspection',
        title: 'Annual inspection',
        method: 'inspection',
        complied_on: '2026-03-14',
        signed_by: 'D. Mechanic',
        signed_certificate: 'A&P/IA 1234567',
      },
    });

    expect(response.statusCode).toBe(201);
    // 14 CFR 91.409 counts calendar months: signed 14 March 2026, good
    // through 31 March 2027 — not the 14th.
    expect(response.json().maintenance_item.due_on).toBe('2027-03-31');
    expect(response.json().maintenance_item.ever_complied).toBe(true);
  });

  it('will not let a compliance record be edited or removed', async () => {
    asAdmin();
    // There is no route to try: append-only is the whole surface (§3.6). The
    // absence is the assertion, and a PATCH lands on the 404 handler.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/compliance-records/00000000-0000-7000-8000-000000000000',
      payload: { title: 'Something else' },
    });
    expect(patch.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/compliance-records`,
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].superseded).toBe(false);
  });

  it('ticks an interval down as flights advance the meters', async () => {
    asAdmin();
    const oil = find(await items(), 'oil_change');

    await app.inject({
      method: 'POST',
      url: '/compliance-records',
      payload: {
        aircraft_id: aircraftId,
        maintenance_item_id: oil.id,
        kind: 'other',
        title: 'Oil and filter change',
        complied_on: new Date().toISOString().slice(0, 10),
        complied_at_hours: '1100.0',
        hours_meter: 'tach',
      },
    });

    expect(find(await items(), 'oil_change').due_at_hours).toBe('1150.0');

    // Nothing in this request mentions maintenance. The flight advances the
    // meters, and the countdown follows — that is the loop, and it is not
    // something a caller can forget to do.
    const flight = await app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': 'maint-flight-0001' },
      payload: {
        aircraft_id: aircraftId,
        flight_date: new Date().toISOString().slice(0, 10),
        tach_start: '1100.0',
        tach_end: '1147.0',
      },
    });
    expect(flight.statusCode).toBe(201);

    const oilAfter = find(await items(), 'oil_change');
    expect(oilAfter.hours_remaining).toBe('3.0');
    expect(oilAfter.state).toBe('due_soon');
  });

  it('lets a pilot file a squawk but not close it', async () => {
    await setBundle('pilot');
    asAdmin();

    const filed = await app.inject({
      method: 'POST',
      url: '/squawks',
      headers: { 'idempotency-key': 'maint-squawk-0001' },
      payload: {
        aircraft_id: aircraftId,
        summary: 'Left brake soft',
        details: 'Pedal travels most of the way before it bites.',
        severity: 'grounding',
      },
    });

    expect(filed.statusCode).toBe(201);
    expect(filed.json().grounding).toBe(true);
    const squawkId = filed.json().id as string;

    // §1.5's line, and the reason squawks is not the same resource as
    // maintenance: a pilot reports a defect and does not sign off the work.
    const close = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { status: 'resolved', resolution_note: 'Looked fine to me' },
    });
    expect(close.statusCode).toBe(403);
    expect(close.json()).toEqual({
      error: 'forbidden',
      // `maintenance.items` since 0027, not `maintenance`: closing a defect is
      // work on the record, not a reading of whether the aeroplane is fit.
      resource: 'maintenance.items',
      level: 'write',
    });

    // Deferring is the same judgement wearing a different hat, so it is the
    // same permission.
    const defer = await app.inject({
      method: 'POST',
      url: `/squawks/${squawkId}/deferrals`,
      payload: { basis: 'far_91_213' },
    });
    expect(defer.statusCode).toBe(403);

    // Reopening is on the maintenance side too. Only checking the way *into*
    // resolved would let any pilot undo a signoff, or lift a deferral and
    // put a grounding back, straight through the API — and §8.1 is explicit
    // that hiding the button is cosmetics.
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { status: 'open' },
    });
    expect(reopen.statusCode).toBe(403);

    // But raising the alarm is never blocked. A pilot who decides the brake
    // is worse than they first said must be able to say so.
    const escalate = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { grounding: true, details: 'Worse on the second taxi.' },
    });
    expect(escalate.statusCode).toBe(200);
    expect(escalate.json().grounding).toBe(true);

    // Clearing it is the other direction, and that is a maintenance call.
    const clear = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { grounding: false },
    });
    expect(clear.statusCode).toBe(403);
  });

  it('previews a rule exactly as the view will report it once saved', async () => {
    /*
      §13: "preview matches saved result".

      The due point and the state come from `next_due_for` and `rule_state`, so
      both callers are reading one implementation and cannot disagree. The one
      piece of arithmetic that is written twice is the subtraction — the view
      does it in SQL over columns, the preview does it in TypeScript over form
      values that have no row yet — and this is what holds those two together.
    */
    asAdmin();

    const item = await withTenant(
      { tenantId: tenant.tenant_id, userId: tenant.user_id },
      async (trx) => {
        const created = await trx
          .insertInto('maintenance_items')
          .values({
            tenant_id: tenant.tenant_id,
            aircraft_id: aircraftId,
            name: 'Parity check',
            due_at_hours: '1275.0',
            warn_within_days: 30,
            warn_within_hours: '10.0',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('maintenance_item_rules')
          .values({
            tenant_id: tenant.tenant_id,
            maintenance_item_id: created.id,
            kind: 'tach_hr',
            every: '50.0',
            due_at_hours: '1275.0',
            warn_at: '10.0',
            critical_at: '3.0',
          })
          .execute();

        return created.id;
      },
    );

    // Where the view says the aeroplane is, so both sides measure from the
    // same number rather than from two readings taken a moment apart.
    const saved = await withTenant(
      { tenantId: tenant.tenant_id, userId: tenant.user_id },
      (trx) =>
        trx
          .selectFrom('maintenance_rule_status')
          .select(['remaining', 'state', 'current_value', 'due_at_hours'])
          .where('maintenance_item_id', '=', item)
          .executeTakeFirstOrThrow(),
    );

    const [preview] = await previewRules(
      db,
      [{ kind: 'tach_hr', every: '50.0', warn_at: '10.0', critical_at: '3.0' }],
      { hours: String(Number(saved.due_at_hours) - 50) },
      { tach: saved.current_value, today: '2026-10-01' },
    );

    expect(preview!.due_at_hours).toBe(saved.due_at_hours);
    expect(Number(preview!.remaining)).toBeCloseTo(Number(saved.remaining), 1);
    expect(preview!.state).toBe(saved.state);
  });

  it('logs a completion, and voiding it restores the previous anchor', async () => {
    // §13, twice: "Mark complete from 1,270.4 on Sep 30 2026 resets oil change
    // to 1,320.4 or Jan 30 2027", and "voiding the latest completion restores
    // the previous anchor".
    //
    // `setBundle` as well as `asAdmin`: an earlier test demotes this membership
    // to Pilot to exercise §1.5's line, and the session being the owner's is
    // not the same thing as the bundle holding the grant.
    asAdmin();
    await setBundle('admin');

    const item = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/maintenance-items`,
      payload: {
        name: 'Oil and filter change',
        due_at_hours: '1275.0',
        rules: [{ kind: 'tach_hr', every: '50.0', anchor_hours: '1225.0' }],
      },
    });
    expect(item.statusCode).toBe(201);
    const itemId = item.json().id as string;
    expect(item.json().rules[0].due_at_hours).toBe('1275.0');

    const first = await app.inject({
      method: 'POST',
      url: `/maintenance-items/${itemId}/completions`,
      payload: { done_on: '2026-08-02', tach: '1225.0', performed_by: 'R. Castellano' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().maintenance_item.rules[0].due_at_hours).toBe('1275.0');

    const second = await app.inject({
      method: 'POST',
      url: `/maintenance-items/${itemId}/completions`,
      payload: { done_on: '2026-09-30', tach: '1270.4', performed_by: 'R. Castellano' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().maintenance_item.rules[0].due_at_hours).toBe('1320.4');
    expect(second.json().maintenance_item.last_complied_on).toBe('2026-09-30');

    // And back. Not a delete: the record stays and the void is its own fact.
    const voided = await app.inject({
      method: 'POST',
      url: `/maintenance-completions/${second.json().id}/void`,
      payload: { reason: 'Logged against the wrong aeroplane' },
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().last_complied_on).toBe('2026-08-02');
    expect(voided.json().rules[0].due_at_hours).toBe('1275.0');

    // Voiding twice is not twice as void.
    const again = await app.inject({
      method: 'POST',
      url: `/maintenance-completions/${second.json().id}/void`,
      payload: { reason: 'Logged against the wrong aeroplane' },
    });
    expect(again.statusCode).toBe(409);

    // The voided record is still on the log, because §3.6 never deletes one.
    const records = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/compliance-records`,
    });
    expect(records.json().length).toBeGreaterThanOrEqual(2);

    /*
      And the item's own log says which one was taken back, and why.

      The screen greys the row rather than losing it: a retracted completion is
      part of the trail and so is the reason. A log that quietly drops one is a
      log that cannot be read back after an accident (§3.6, §7.2).
    */
    const logged = await app.inject({
      method: 'GET',
      url: `/maintenance-items/${itemId}/completions`,
    });
    expect(logged.statusCode).toBe(200);
    const rows = logged.json() as {
      id: string;
      complied_on: string;
      voided?: boolean;
      void_reason?: string | null;
    }[];
    expect(rows).toHaveLength(2);

    const retracted = rows.find((row) => row.id === second.json().id);
    expect(retracted?.voided).toBe(true);
    expect(retracted?.void_reason).toBe('Logged against the wrong aeroplane');

    const standing = rows.find((row) => row.complied_on === '2026-08-02');
    expect(standing?.voided).toBe(false);
  });

  it('serves one item by id, and nothing at all from another tenant', async () => {
    /*
      A notification carries an item id and no aircraft id, so a deep link has
      to be able to ask for one item. The pair of assertions is §6.1 items 5
      and 6 in their read form: the id resolves in the tenant that owns it and
      is simply not there in the one that does not.

      §6 is explicit about which answer that is — "Aircraft not found" for a
      tail number in another tenant, never "you don't have access to that
      aircraft" — so the second half asserts a 404 and not a 403.
    */
    asAdmin();
    await setBundle('admin');

    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/maintenance-items`,
      payload: {
        name: 'Transponder check',
        rules: [{ kind: 'cal_month', every: '24', anchor_on: '2026-03-01' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const itemId = created.json().id as string;

    const mine = await app.inject({ method: 'GET', url: `/maintenance-items/${itemId}` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().name).toBe('Transponder check');
    expect(mine.json().rules).toHaveLength(1);

    asOtherTenant();
    const theirs = await app.inject({ method: 'GET', url: `/maintenance-items/${itemId}` });
    expect(theirs.statusCode).toBe(404);

    // And the log behind it, which would otherwise be a second way in.
    const theirLog = await app.inject({
      method: 'GET',
      url: `/maintenance-items/${itemId}/completions`,
    });
    expect(theirLog.statusCode).toBe(404);

    // Back to this tenant's session: the suite shares one app, and leaving
    // somebody else's context behind is how the next test fails for the wrong
    // reason.
    asAdmin();
  });

  it('warns that a booking would cross an hour-based item, and only warns', async () => {
    /*
      SPEC §4.6. The three assertions are the whole behaviour: a short block
      crosses nothing, a long one names what it would cross, and a pilot — who
      holds nothing on the maintenance record — can still ask.

      Nothing here refuses anything. A booking is refused by
      `aircraft_availability` and by the exclusion constraint, and neither of
      them is this.
    */
    asAdmin();
    await setBundle('admin');

    const aircraft = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    const tach = Number(aircraft.json().tach ?? 0);

    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/maintenance-items`,
      payload: {
        name: '100-hour inspection',
        grounds_aircraft: true,
        // Two hours out, whatever the aeroplane happens to be sitting at.
        rules: [{ kind: 'tach_hr', every: '100.0', anchor_hours: String((tach - 98).toFixed(1)) }],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(Number(created.json().governing_remaining)).toBeCloseTo(2, 1);

    const short = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/bookings/check?hours=1.0`,
    });
    expect(short.statusCode).toBe(200);
    expect(short.json().crosses).toEqual([]);

    const long = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/bookings/check?hours=3.5`,
    });
    expect(long.statusCode).toBe(200);
    expect(long.json().hours).toBe('3.5');
    const crossed = long.json().crosses as {
      name: string;
      kind: string;
      grounds_aircraft: boolean;
    }[];
    expect(crossed.map((row) => row.name)).toContain('100-hour inspection');
    const hundred = crossed.find((row) => row.name === '100-hour inspection')!;
    expect(hundred.kind).toBe('tach_hr');
    expect(hundred.grounds_aircraft).toBe(true);

    // And the booking path is a pilot's path. `reservations: read`, which they
    // hold, rather than the record, which they do not.
    await setBundle('pilot');
    const asPilot = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/bookings/check?hours=3.5`,
    });
    expect(asPilot.statusCode).toBe(200);
    expect((asPilot.json().crosses as unknown[]).length).toBeGreaterThan(0);

    await setBundle('admin');
  });

  it('shuts a pilot out of the maintenance record, not out of the aeroplane', async () => {
    /*
      SPEC §3's line, and the one change in Phase 1 that takes something away
      from somebody who already had it. A pilot could read the whole fleet's
      maintenance list until 0027 split the resource; now the record is the
      admin's and the pilot is told what they need to fly safely.

      The summary half arrives with its endpoint in 1D. This asserts the half
      that exists: the record is closed, and the aeroplane's dispatch state —
      which is `aircraft: read` and deliberately ungated — is not.
    */
    await setBundle('pilot');

    for (const url of [
      '/maintenance',
      `/aircraft/${aircraftId}/maintenance-items`,
      `/aircraft/${aircraftId}/compliance-records`,
      '/work-orders',
    ]) {
      const refused = await app.inject({ method: 'GET', url });
      expect(refused.statusCode, url).toBe(403);
      expect(refused.json().resource, url).toBe('maintenance.items');
    }

    // Still told whether it flies. §3.3 keeps that on `aircraft: read` so the
    // booking path never has to ask the maintenance module's permission.
    const dispatch = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/availability`,
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json()).toHaveProperty('available');

    await setBundle('admin');
  });

  it('lets a pilot into the app at all', async () => {
    // The app shell reads /tenant on every page. It used to require
    // `settings: read`, which the Pilot bundle grants as `none`, so every
    // pilot-facing feature in the product was behind a 403 that the web app
    // read as an expired session — login, bounce, login, bounce.
    await setBundle('pilot');
    asAdmin();

    const tenant = await app.inject({ method: 'GET', url: '/tenant' });
    expect(tenant.statusCode).toBe(200);
    expect(tenant.json().name).toBe(`Test maint-a`);

    // And the things a pilot is there for still answer.
    expect((await app.inject({ method: 'GET', url: '/aircraft' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/squawks' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/availability' })).statusCode).toBe(200);

    // §4.4's third dimension reaches the client, so a screen can say "My
    // charges" rather than "Charges" — and hide what it would be refused.
    // The refusing is the ledger's policy's job (§10), not this field's.
    const pilotGates = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(pilotGates.json().permissions.charges).toBe('read');
    expect(pilotGates.json().permission_scopes.charges).toBe('own');
    // The rest of the club stays shared: the next pilot needs to know what
    // the last one found.
    expect(pilotGates.json().permission_scopes.squawks).toBe('all');

    await setBundle('admin');

    const adminGates = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(adminGates.json().permission_scopes.charges).toBe('all');
  });

  it('grounds the aircraft, by name, and hands the scheduler one answer', async () => {
    await setBundle('admin');
    asAdmin();

    const response = await app.inject({ method: 'GET', url: '/availability' });
    const [fleet] = response.json();

    expect(fleet.available).toBe(false);
    expect(fleet.grounding_squawks).toBe(1);
    expect(fleet.grounding_reasons).toContain('Grounding squawk: Left brake soft');
  });

  it('treats a deferral as the decision that it may fly, and keeps the record', async () => {
    asAdmin();
    const open = await app.inject({ method: 'GET', url: '/squawks?open=true' });
    const squawkId = open.json()[0].id as string;

    const deferred = await app.inject({
      method: 'POST',
      url: `/squawks/${squawkId}/deferrals`,
      payload: {
        basis: 'far_91_213',
        expires_on: '2027-01-31',
        note: 'Second brake serviceable; placarded.',
      },
    });
    expect(deferred.statusCode).toBe(201);
    expect(deferred.json().status).toBe('deferred');
    expect(deferred.json().deferrals).toHaveLength(1);

    const available = await app.inject({ method: 'GET', url: '/availability' });
    expect(available.json()[0].available).toBe(true);

    // Lifting it grounds the aircraft again, and the row that authorised the
    // flights in between is exactly where it was (§7.2: deferral history).
    const reopened = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { status: 'open' },
    });
    expect(reopened.json().deferrals).toHaveLength(1);

    const grounded = await app.inject({ method: 'GET', url: '/availability' });
    expect(grounded.json()[0].available).toBe(false);

    const resolved = await app.inject({
      method: 'PATCH',
      url: `/squawks/${squawkId}`,
      payload: { status: 'resolved', resolution_note: 'Master cylinder replaced.' },
    });
    expect(resolved.json().status).toBe('resolved');
    expect((await app.inject({ method: 'GET', url: '/availability' })).json()[0].available)
      .toBe(true);
  });

  it('closes a signed work order to further edits', async () => {
    asAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/work-orders',
      payload: {
        aircraft_id: aircraftId,
        description: 'Replace left brake master cylinder.',
        performed_by: "Dave's Aircraft Service",
        parts: [{ part_number: '10-63', description: 'Master cylinder', qty: 1 }],
        labor_hours: '2.5',
        cost_cents: 48750,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // Editable while it is open.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/work-orders/${id}`,
      payload: { labor_hours: '3.0' },
    });
    expect(edited.json().labor_hours).toBe('3.0');

    const signed = await app.inject({
      method: 'PATCH',
      url: `/work-orders/${id}`,
      payload: {
        signoff_name: 'D. Mechanic',
        signoff_certificate: 'A&P 1234567',
        signoff_kind: 'a_and_p',
      },
    });
    expect(signed.json().signed_at).not.toBeNull();
    expect(signed.json().status).toBe('closed');

    // A signature is not revisable. 409 rather than 500: the database refuses
    // it with its own SQLSTATE precisely so this reads as a conflict.
    const after = await app.inject({
      method: 'PATCH',
      url: `/work-orders/${id}`,
      payload: { cost_cents: 1 },
    });
    expect(after.statusCode).toBe(409);
    expect(after.json().error).toBe('conflict');
  });

  it('shows another tenant none of it', async () => {
    asOtherTenant();

    expect((await app.inject({ method: 'GET', url: '/maintenance' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/squawks' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/work-orders' })).json()).toEqual([]);

    // §6: an aircraft in another tenant is "not found", never "you don't
    // have access to that aircraft" — the two have to be indistinguishable.
    const peek = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/maintenance-items`,
    });
    expect(peek.statusCode).toBe(404);

    const availability = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/availability`,
    });
    expect(availability.statusCode).toBe(404);
  });
});
