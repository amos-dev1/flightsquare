import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * An archived aeroplane is out of the fleet: its maintenance items and
 * squawks leave the fleet-wide lists, stay on record when asked for by
 * aircraft (§5.5), and come back the moment it is restored.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000fc';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('archived aircraft', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let aircraftId: string;
  let itemId: string;
  let squawkId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    const tenant = await provisionTestTenant('archived-aircraft');
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
        payload: { registration: 'N47ARC', type_code: 'C172', tach: '1000.0' },
      })
    ).json().id;
    itemId = (
      await app.inject({
        method: 'POST',
        url: `/aircraft/${aircraftId}/maintenance-items`,
        payload: {
          name: 'Oil change',
          rules: [{ kind: 'tach_hr', every: '50.0', anchor_hours: '990.0' }],
        },
      })
    ).json().id;
    squawkId = (
      await app.inject({
        method: 'POST',
        url: '/squawks',
        headers: { 'idempotency-key': 'archived-aircraft-squawk-0001' },
        payload: { aircraft_id: aircraftId, summary: 'Nav light out', severity: 'minor' },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  const ids = async (url: string) =>
    ((await app.inject({ method: 'GET', url })).json() as { id: string }[]).map((row) => row.id);

  const setStatus = (status: 'active' | 'archived') =>
    app.inject({ method: 'PATCH', url: `/aircraft/${aircraftId}`, payload: { status } });

  it('lists its maintenance and squawks while it is in the fleet', async () => {
    expect(await ids('/maintenance')).toContain(itemId);
    expect(await ids('/squawks')).toContain(squawkId);
  });

  it('takes them off the fleet-wide lists once archived, and keeps them by aircraft', async () => {
    expect((await setStatus('archived')).statusCode).toBe(200);

    expect(await ids('/maintenance')).not.toContain(itemId);
    expect(await ids('/squawks')).not.toContain(squawkId);

    expect(await ids(`/maintenance?aircraft_id=${aircraftId}`)).toContain(itemId);
    expect(await ids(`/squawks?aircraft_id=${aircraftId}`)).toContain(squawkId);
  });

  it('brings them back when it is restored', async () => {
    expect((await setStatus('active')).statusCode).toBe(200);

    expect(await ids('/maintenance')).toContain(itemId);
    expect(await ids('/squawks')).toContain(squawkId);
  });
});
