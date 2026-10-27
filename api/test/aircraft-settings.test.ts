import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * Saving an aeroplane's settings with fields left blank.
 *
 * Both clients send null for "not recorded". The schema used to refuse it for
 * seats and fuel capacity, so saving the settings of a new aeroplane — which
 * has neither — was a 400 on the web.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000fc';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('aircraft settings', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    const tenant = await provisionTestTenant('aircraft-settings');
    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    aircraftId = (
      await app.inject({
        method: 'POST',
        url: '/aircraft',
        payload: { registration: 'N46SET', seats: 4, fuel_capacity: '53.0' },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives the last fuel reading as a percent of capacity', async () => {
    const flight = await app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': `aircraft-settings-fuel-${Date.now()}` },
      payload: {
        aircraft_id: aircraftId,
        flight_date: '2026-10-01',
        hobbs_start: '100.0',
        hobbs_end: '101.2',
        fuel_remaining_after: '26.5',
      },
    });
    expect(flight.statusCode).toBe(201);

    const aircraft = (await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` })).json();
    expect(aircraft.fuel_remaining_percent).toBe(50);
  });

  it('clears seats and fuel capacity when they are sent blank', async () => {
    const saved = await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { home_base: null, seats: null, fuel_capacity: null, billing_meter: 'hobbs' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ seats: null, fuel_capacity: null, home_base: null });
  });

  it('still refuses a seat count or fuel figure that is not one', async () => {
    const seats = await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { seats: 0 },
    });
    expect(seats.statusCode).toBe(400);

    const fuel = await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { fuel_capacity: 'lots' },
    });
    expect(fuel.statusCode).toBe(400);
  });
});
