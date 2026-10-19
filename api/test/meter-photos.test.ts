import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { ensureBucket } from '../src/storage/index.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * Meter photographs (0042).
 *
 * The setting asks; it never refuses. What these prove is the half only the
 * API can get wrong: a flight without a photograph still goes in, says it is
 * missing one, and stops saying so when one arrives through its own door —
 * and the squawk door cannot be used to reach it.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000f8';
let keyCounter = 0;
const nextKey = () => `vitest-meter-${Date.now()}-${keyCounter++}`;

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('meter photographs', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let aircraftId: string;
  let hobbs = 300;

  beforeAll(async () => {
    await cleanupTestTenants();
    await ensureBucket();
    const tenant = await provisionTestTenant('meter-photos');

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
        payload: { registration: 'N42MTR', type_code: 'C172' },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  function logFlight(extra: Record<string, unknown> = {}) {
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
        ...extra,
      },
    });
  }

  async function attachPhoto(flightId: string) {
    const bytes = Buffer.alloc(2048, 7);
    const created = await app.inject({
      method: 'POST',
      url: `/flights/${flightId}/attachments`,
      payload: { content_type: 'image/jpeg', byte_size: bytes.length },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ flight_id: flightId, kind: 'meter_photo' });

    const put = await fetch(created.json().upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const completed = await app.inject({
      method: 'POST',
      url: `/flights/${flightId}/attachments/${created.json().id}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    return created.json().id as string;
  }

  it('is off until an admin turns it on, and then the aeroplane says so', async () => {
    const before = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(before.json().require_meter_photos).toBe(false);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { require_meter_photos: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().require_meter_photos).toBe(true);
  });

  it('takes a flight with no photograph, and says it is missing one', async () => {
    // §8.1: every phone build already shipped logs a flight like this one.
    const flight = await logFlight();
    expect(flight.statusCode).toBe(201);
    expect(flight.json().meter_photo_missing).toBe(true);
    expect(flight.json().meter_photos).toBe(0);
  });

  it('stops saying so once one arrives through the flight’s own door', async () => {
    const flight = (await logFlight()).json();
    const photoId = await attachPhoto(flight.id);

    const read = await app.inject({ method: 'GET', url: `/flights/${flight.id}` });
    expect(read.json().meter_photo_missing).toBe(false);
    expect(read.json().meter_photos).toBe(1);

    const list = await app.inject({ method: 'GET', url: `/flights/${flight.id}/attachments` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: photoId, kind: 'meter_photo' });
    expect(list.json()[0].url).toMatch(/^https?:\/\//);

    // The squawk door serves squawk-owned or ownerless rows and nothing else,
    // so `squawks` cannot be used to reach a photograph gated on `flights`.
    const viaSquawkDoor = await app.inject({ method: 'GET', url: `/attachments/${photoId}` });
    expect(viaSquawkDoor.statusCode).toBe(404);
  });

  it('lets a correction keep the photograph of the flight it replaces', async () => {
    const wrong = (await logFlight()).json();
    await attachPhoto(wrong.id);

    const right = await logFlight({
      supersedes_id: wrong.id,
      correction_reason: 'Hobbs misread',
    });
    expect(right.statusCode).toBe(201);
    expect(right.json().meter_photo_missing).toBe(false);
    expect(right.json().meter_photos).toBe(1);
  });

  it('asks nothing of flights logged while it was off', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { require_meter_photos: false },
    });
    const flight = await logFlight();
    expect(flight.json().meter_photo_missing).toBe(false);

    // Turning it back on does not reach back into that flight.
    await app.inject({
      method: 'PATCH',
      url: `/aircraft/${aircraftId}`,
      payload: { require_meter_photos: true },
    });
    const read = await app.inject({ method: 'GET', url: `/flights/${flight.json().id}` });
    expect(read.json().meter_photo_missing).toBe(false);
  });

  it('refuses anything but a meter photograph through this door, and 404s a flight it cannot see', async () => {
    const flight = (await logFlight()).json();
    const wrongKind = await app.inject({
      method: 'POST',
      url: `/flights/${flight.id}/attachments`,
      payload: { content_type: 'image/jpeg', byte_size: 10, kind: 'invoice' },
    });
    expect(wrongKind.statusCode).toBe(400);

    const nowhere = await app.inject({
      method: 'POST',
      url: '/flights/01920000-0000-7000-8000-00000000dead/attachments',
      payload: { content_type: 'image/jpeg', byte_size: 10 },
    });
    expect(nowhere.statusCode).toBe(404);
  });
});
