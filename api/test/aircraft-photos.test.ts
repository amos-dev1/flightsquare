import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { ensureBucket } from '../src/storage/index.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * The aeroplane's picture (0043).
 *
 * What these prove: an upload becomes the picture every aircraft response
 * carries, a replacement puts its predecessor aside rather than deleting it,
 * a removal leaves no picture, and the squawk door cannot reach one.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000f9';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('aircraft photographs', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await ensureBucket();
    const tenant = await provisionTestTenant('aircraft-photos');

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
        payload: { registration: 'N43PIC', type_code: 'C172' },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function uploadPhoto() {
    const bytes = Buffer.alloc(4096, 3);
    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/photo`,
      payload: { content_type: 'image/jpeg', byte_size: bytes.length },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ aircraft_id: aircraftId, kind: 'aircraft_photo' });

    const put = await fetch(created.json().upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const completed = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/photo/${created.json().id}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    return { id: created.json().id as string, aircraft: completed.json() };
  }

  it('has no picture until somebody uploads one', async () => {
    const read = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(read.json().photo).toBeNull();
  });

  it('carries the uploaded picture on the aeroplane and the fleet list', async () => {
    const { id, aircraft } = await uploadPhoto();
    expect(aircraft.photo).toMatchObject({ attachment_id: id });
    expect(aircraft.photo.url).toMatch(/^https?:\/\//);

    const list = await app.inject({ method: 'GET', url: '/aircraft' });
    const row = list.json().find((a: { id: string }) => a.id === aircraftId);
    expect(row.photo).toMatchObject({ attachment_id: id });

    // Gated on `aircraft`, not on `squawks`: the squawk door cannot read it.
    const viaSquawkDoor = await app.inject({ method: 'GET', url: `/attachments/${id}` });
    expect(viaSquawkDoor.statusCode).toBe(404);
  });

  it('replaces the picture, and the old one cannot be completed again', async () => {
    const first = (await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` })).json()
      .photo.attachment_id;
    const { id } = await uploadPhoto();
    expect(id).not.toBe(first);

    const read = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}` });
    expect(read.json().photo.attachment_id).toBe(id);

    // Put aside, not deleted — and no longer something this door serves.
    const again = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/photo/${first}/complete`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('removes the picture, leaving none', async () => {
    const removed = await app.inject({ method: 'POST', url: `/aircraft/${aircraftId}/photo/remove` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().photo).toBeNull();
  });

  it('takes only a photograph, and 404s an aeroplane it cannot see', async () => {
    const pdf = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/photo`,
      payload: { content_type: 'application/pdf', byte_size: 10 },
    });
    expect(pdf.statusCode).toBe(400);

    const nowhere = await app.inject({
      method: 'POST',
      url: '/aircraft/01920000-0000-7000-8000-00000000dead/photo',
      payload: { content_type: 'image/jpeg', byte_size: 10 },
    });
    expect(nowhere.statusCode).toBe(404);
  });
});
