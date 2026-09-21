import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { addTestMember, cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';
import { withTenant } from '../src/db/context.js';

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

  it('seeds the applicable presets when an aircraft is added, and invents nothing', async () => {
    asAdmin();
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
      resource: 'maintenance',
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
