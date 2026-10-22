import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { addTestMember, cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * Logging a flight for somebody else (0044).
 *
 * `flown_by` is who owes for the flight, so naming another member is an
 * admin's act. The database decides; these prove the API answers it in the
 * right words — 403 for a Pilot, 400 for somebody who is not a member.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000fa';
let keyCounter = 0;
const nextKey = () => `vitest-flown-by-${Date.now()}-${keyCounter++}`;

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('logging a flight for somebody else', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let admin: ResolvedSession;
  let pilot: ResolvedSession;
  let adminMembership: string;
  let pilotMembership: string;
  let aircraftId: string;
  let hobbs = 100;

  beforeAll(async () => {
    await cleanupTestTenants();
    const tenant = await provisionTestTenant('flown-by');
    const pilotMember = await addTestMember(tenant.tenant_id, 'flown-by-pilot', 'pilot');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();

    admin = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    pilot = { sessionId: SESSION_ID, userId: pilotMember.user_id, tenantId: tenant.tenant_id };
    pilotMembership = pilotMember.membership_id;

    stub = admin;
    aircraftId = (
      await app.inject({
        method: 'POST',
        url: '/aircraft',
        payload: { registration: 'N44FOR', type_code: 'C172' },
      })
    ).json().id;
    const members = (await app.inject({ method: 'GET', url: '/members' })).json();
    adminMembership = members.find((m: { user_id: string }) => m.user_id === tenant.user_id).id;
  });

  afterAll(async () => {
    await app.close();
  });

  function logFlight(flownBy?: string) {
    const start = hobbs;
    hobbs += 1;
    return app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': nextKey() },
      payload: {
        aircraft_id: aircraftId,
        flight_date: '2026-10-01',
        hobbs_start: start.toFixed(1),
        hobbs_end: hobbs.toFixed(1),
        ...(flownBy ? { flown_by: flownBy } : {}),
      },
    });
  }

  it('lets an admin log a flight for a pilot, and it is theirs', async () => {
    stub = admin;
    const flight = await logFlight(pilotMembership);
    expect(flight.statusCode).toBe(201);
    expect(flight.json().flown_by).toBe(pilotMembership);
  });

  it('lets a pilot log their own, named or not', async () => {
    stub = pilot;
    expect((await logFlight()).json().flown_by).toBe(pilotMembership);
    expect((await logFlight(pilotMembership)).statusCode).toBe(201);
  });

  it('refuses a pilot logging one for somebody else', async () => {
    stub = pilot;
    const flight = await logFlight(adminMembership);
    expect(flight.statusCode).toBe(403);
  });

  it('keeps the pilot when an admin corrects their flight without naming anybody', async () => {
    stub = pilot;
    const original = (await logFlight()).json();
    stub = admin;
    const corrected = await app.inject({
      method: 'POST',
      url: '/flights',
      headers: { 'idempotency-key': nextKey() },
      payload: {
        aircraft_id: aircraftId,
        flight_date: '2026-10-01',
        hobbs_start: original.hobbs_start,
        hobbs_end: original.hobbs_end,
        supersedes_id: original.id,
        correction_reason: 'Wrong date on the sheet',
      },
    });
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json().flown_by).toBe(pilotMembership);
  });

  it('says so in words when the person is not a member', async () => {
    stub = admin;
    const flight = await logFlight('01920000-0000-7000-8000-00000000dead');
    expect(flight.statusCode).toBe(400);
  });
});
