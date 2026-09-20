import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000d0';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('fleet', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let alpha: Awaited<ReturnType<typeof provisionTestTenant>>;
  let bravo: Awaited<ReturnType<typeof provisionTestTenant>>;

  beforeAll(async () => {
    await cleanupTestTenants();
    alpha = await provisionTestTenant('fleet-a');
    bravo = await provisionTestTenant('fleet-b');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function asAlpha(): void {
    stub = { sessionId: SESSION_ID, userId: alpha.user_id, tenantId: alpha.tenant_id };
  }
  function asBravo(): void {
    stub = { sessionId: SESSION_ID, userId: bravo.user_id, tenantId: bravo.tenant_id };
  }

  async function addAircraft(registration: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/aircraft',
      payload: { registration, type_code: 'C172', home_base: 'KPAO', ...extra },
    });
  }

  it('adds an aircraft and starts it with no meters', async () => {
    asAlpha();
    const response = await addAircraft('N123AB', { seats: 4, maintenance_meter: 'tach' });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.registration).toBe('N123AB');
    expect(body.maintenance_meter).toBe('tach');
    // Nothing has been read off the aircraft yet, so there is nothing to show.
    expect(body.hobbs).toBeNull();
    expect(body.tach).toBeNull();
    expect(body.totals_updated_at).toBeNull();
  });

  it('refuses a second aircraft on a free plan, with a body the UI can act on', async () => {
    asAlpha();
    const response = await addAircraft('N456CD');

    // 402, not 403: the remediation is a plan change, and §1.6 keeps that
    // orthogonal to both permission and rate limiting.
    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: 'quota_exceeded',
      quota: 'aircraft.active',
      limit: 1,
      current: 1,
      remediation: ['upgrade', 'archive'],
    });
  });

  it('lets the same tail number exist in another tenant', async () => {
    // §3.2's leaseback case: the owner tracks maintenance while the club
    // schedules the same airframe. Neither record is a duplicate.
    asBravo();
    const response = await addAircraft('N123AB');
    expect(response.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/aircraft' });
    expect(list.json()).toHaveLength(1);
  });

  it('cannot reach another tenant aircraft, and cannot tell it apart from one that does not exist', async () => {
    asAlpha();
    const mine = await app.inject({ method: 'GET', url: '/aircraft' });
    const id = mine.json()[0].id;

    asBravo();
    const theirs = await app.inject({ method: 'GET', url: `/aircraft/${id}` });
    const imaginary = await app.inject({
      method: 'GET',
      url: '/aircraft/01920000-0000-7000-8000-00000000dead',
    });

    expect(theirs.statusCode).toBe(404);
    expect(imaginary.statusCode).toBe(404);
    // Byte-identical: §6, errors do not leak cross-tenant existence.
    expect(theirs.json()).toEqual(imaginary.json());
  });

  it('advances the totals from readings, and never by assertion', async () => {
    asAlpha();
    const id = (await app.inject({ method: 'GET', url: '/aircraft' })).json()[0].id;

    const first = await app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-readings`,
      payload: { hobbs: '1200.4', tach: '1100.2', airframe_hours: '1200.4' },
    });
    expect(first.statusCode).toBe(201);

    const after = await app.inject({ method: 'GET', url: `/aircraft/${id}` });
    expect(after.json().hobbs).toBe('1200.4');
    expect(after.json().tach).toBe('1100.2');
    expect(after.json().totals_updated_at).toEqual(expect.any(String));

    // Meters stay strings end to end. A float round-trip is how a maintenance
    // countdown quietly drifts.
    expect(typeof after.json().hobbs).toBe('string');

    // A Hobbs-only reading must not blank the tach.
    await app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-readings`,
      payload: { hobbs: '1202.9' },
    });
    const later = await app.inject({ method: 'GET', url: `/aircraft/${id}` });
    expect(later.json().hobbs).toBe('1202.9');
    expect(later.json().tach).toBe('1100.2');
  });

  it('does not let a late-arriving older reading roll the meter back', async () => {
    asAlpha();
    const id = (await app.inject({ method: 'GET', url: '/aircraft' })).json()[0].id;

    // §8.2: two pilots fly the same aircraft on the same afternoon and sync
    // in the wrong sequence. The server orders by recorded_at, not arrival.
    await app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-readings`,
      payload: { hobbs: '1201.5', recorded_at: new Date(Date.now() - 86_400_000).toISOString() },
    });

    const after = await app.inject({ method: 'GET', url: `/aircraft/${id}` });
    expect(after.json().hobbs).toBe('1202.9');
  });

  it('keeps a correction and what it corrected, both labelled', async () => {
    asAlpha();
    const id = (await app.inject({ method: 'GET', url: '/aircraft' })).json()[0].id;
    const before = await app.inject({ method: 'GET', url: `/aircraft/${id}/meter-readings` });
    const target = before.json().at(-1);

    await app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-readings`,
      payload: { hobbs: '1200.9', supersedes_id: target.id, note: 'transposed digits' },
    });

    const log = await app.inject({ method: 'GET', url: `/aircraft/${id}/meter-readings` });
    const rows = log.json();
    // Nothing disappeared: the log is the audit trail, so the superseded row
    // is labelled rather than hidden.
    expect(rows.find((r: { id: string }) => r.id === target.id).superseded).toBe(true);
    expect(rows.some((r: { note: string | null }) => r.note === 'transposed digits')).toBe(true);
  });

  it('rejects a reading that records nothing', async () => {
    asAlpha();
    const id = (await app.inject({ method: 'GET', url: '/aircraft' })).json()[0].id;
    const response = await app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-readings`,
      payload: { note: 'forgot to read anything' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('frees the quota when an aircraft is archived, and keeps its history', async () => {
    asAlpha();
    const id = (await app.inject({ method: 'GET', url: '/aircraft' })).json()[0].id;

    const archived = await app.inject({
      method: 'PATCH',
      url: `/aircraft/${id}`,
      payload: { status: 'archived' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe('archived');

    // §5.5: archiving is reversible and non-destructive — the readings stay.
    const log = await app.inject({ method: 'GET', url: `/aircraft/${id}/meter-readings` });
    expect(log.json().length).toBeGreaterThan(0);

    // And the slot is free again.
    const replacement = await addAircraft('N789EF');
    expect(replacement.statusCode).toBe(201);
  });

  it('serves reference data without a tenant', async () => {
    stub = { sessionId: SESSION_ID, userId: alpha.user_id };

    const types = await app.inject({ method: 'GET', url: '/reference/aircraft-types?q=cessna' });
    expect(types.statusCode).toBe(200);
    expect(types.json().some((t: { code: string }) => t.code === 'C172')).toBe(true);

    const fields = await app.inject({ method: 'GET', url: '/reference/aerodromes?q=KPA' });
    expect(fields.json()[0].ident).toBe('KPAO');
  });

  it('refuses the fleet to a session with no tenant selected', async () => {
    stub = { sessionId: SESSION_ID, userId: alpha.user_id };
    const response = await app.inject({ method: 'GET', url: '/aircraft' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'tenant_required' });
  });
});
