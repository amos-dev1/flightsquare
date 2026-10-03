import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { ensureBucket } from '../src/storage/index.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  cleanupTestTenants,
  provisionTestTenant,
  setQuotaOverride,
} from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000f0';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * Attachments (§3.8), and the thing that is actually new about them: the bytes
 * do not come through the API at all.
 *
 * A create signs a PUT the device uses directly, a completion reads back what
 * storage received, and a read signs a GET. What this suite is really testing
 * is the seam between those three — that the quota is asserted before anything
 * is sent, that a declared size is not taken on trust, and that a row without
 * a file is a declaration rather than an attachment.
 *
 * Needs the `storage` service from docker-compose, the same way the rest of
 * the suite needs the database.
 */
describe('attachments', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;
  let other: Awaited<ReturnType<typeof provisionTestTenant>>;
  let aircraftId: string;
  let squawkId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await ensureBucket();

    tenant = await provisionTestTenant('attach-a');
    other = await provisionTestTenant('attach-b');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();

    asTenant();
    aircraftId = (
      await app.inject({
        method: 'POST',
        url: '/aircraft',
        payload: { registration: 'N77ATT', type_code: 'C172' },
      })
    ).json().id;

    squawkId = (
      await app.inject({
        method: 'POST',
        url: '/squawks',
        headers: { 'idempotency-key': 'attach-squawk-0001' },
        payload: { aircraft_id: aircraftId, summary: 'Cracked nose gear fairing' },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  function asTenant(): void {
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
  }
  function asOtherTenant(): void {
    stub = { sessionId: SESSION_ID, userId: other.user_id, tenantId: other.tenant_id };
  }

  function create(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/attachments', payload });
  }

  it('signs an upload the API never sees the bytes of', async () => {
    asTenant();
    const response = await create({
      squawk_id: squawkId,
      content_type: 'image/jpeg',
      byte_size: 1024,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.uploaded).toBe(false);
    expect(body.upload_url).toMatch(/^https?:\/\//);
    // A signed URL, not a public one: the credential is in the query string
    // and it expires.
    expect(body.upload_url).toContain('X-Amz-Signature');
  });

  it('takes a PDF now, refuses what it still does not, and refuses the oversized', async () => {
    asTenant();

    /*
      Inverted deliberately, and this line is the record of why.

      It asserted 400 for a PDF until records arrived (SPEC Phase 2): a shop
      emails an invoice as a PDF and a broker emails an insurance certificate
      as one, and telling somebody to photograph their screen would be the
      app's problem becoming theirs.
    */
    const pdf = await create({ content_type: 'application/pdf', byte_size: 1024 });
    expect(pdf.statusCode).toBe(201);

    // The list is still a list. Anything not on it is refused.
    const doc = await create({
      content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byte_size: 1024,
    });
    expect(doc.statusCode).toBe(400);

    const huge = await create({ content_type: 'image/jpeg', byte_size: 64 * 1024 * 1024 });
    expect(huge.statusCode).toBe(400);
    // Refused before it is signed. Telling a phone on one bar that its
    // fifteen minutes of uploading was wasted is not enforcement, it is
    // punishment.
    expect(huge.json().detail).toContain('larger than');
  });

  it('does not count a row until something has actually arrived', async () => {
    asTenant();
    const created = await create({ content_type: 'image/jpeg', byte_size: 500_000 });
    const id = created.json().id;

    const before = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(before.json().quotas['storage.bytes'].current).toBe(0);

    // Nothing was uploaded, so completion has nothing to record and says so
    // rather than marking a row that names no object as an attachment.
    const completed = await app.inject({ method: 'POST', url: `/attachments/${id}/complete` });
    expect(completed.statusCode).toBe(400);

    // And a read of it offers no URL, because there is nothing to read.
    const read = await app.inject({ method: 'GET', url: `/attachments/${id}` });
    expect(read.json().uploaded).toBe(false);
    expect(read.json().url).toBeUndefined();
  });

  it('counts what storage received, not what the client claimed', async () => {
    asTenant();
    const bytes = Buffer.alloc(4096, 7);

    const created = await create({
      squawk_id: squawkId,
      content_type: 'image/png',
      // A lie, and a cheap one: declare a kilobyte and send four.
      byte_size: 1,
    });
    const { id, upload_url: url } = created.json();

    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const completed = await app.inject({ method: 'POST', url: `/attachments/${id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().byte_size).toBe(4096);
    expect(completed.json().uploaded).toBe(true);

    // `storage.bytes` has had a limit since 0005 and nothing counted it until
    // 0020. This is the assertion that it stopped being fictional.
    const entitlements = await app.inject({ method: 'GET', url: '/entitlements' });
    expect(entitlements.json().quotas['storage.bytes'].current).toBe(4096);

    // And the bytes come back.
    const read = await app.inject({ method: 'GET', url: `/attachments/${id}` });
    const fetched = await fetch(read.json().url);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('lists what hangs off a squawk', async () => {
    asTenant();
    const list = await app.inject({ method: 'GET', url: `/squawks/${squawkId}/attachments` });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBeGreaterThanOrEqual(2);
    expect(list.json().every((row: { squawk_id: string }) => row.squawk_id === squawkId)).toBe(
      true,
    );
  });

  it('refuses on size rather than on count when the quota is exhausted', async () => {
    // A byte quota is not consumed one at a time, which is what 0021 widened
    // assert_quota for: this tenant has 4096 bytes stored and a limit of
    // 5000, so a 2 KiB photograph does not fit even though the count of
    // attachments is nowhere near anything.
    await setQuotaOverride(tenant.tenant_id, 'storage.bytes', 5000);
    asTenant();

    const response = await create({ content_type: 'image/jpeg', byte_size: 2048 });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: 'quota_exceeded',
      quota: 'storage.bytes',
      limit: 5000,
      current: 4096,
      remediation: ['upgrade', 'archive'],
    });

    // Under it, the same call is fine — the refusal was arithmetic, not a wall.
    const small = await create({ content_type: 'image/jpeg', byte_size: 900 });
    expect(small.statusCode).toBe(201);

    await setQuotaOverride(tenant.tenant_id, 'storage.bytes', 'unlimited');
  });

  it('will not hang a photograph off another tenant’s squawk', async () => {
    asOtherTenant();
    const response = await create({
      squawk_id: squawkId,
      content_type: 'image/jpeg',
      byte_size: 1024,
    });

    // §6: "not found", never "you don't have access to that" — the error does
    // not confirm that the squawk exists somewhere.
    expect(response.statusCode).toBe(404);
  });

  it('will not read another tenant’s attachment', async () => {
    asTenant();
    const created = await create({ content_type: 'image/jpeg', byte_size: 1024 });
    const id = created.json().id;

    asOtherTenant();
    const read = await app.inject({ method: 'GET', url: `/attachments/${id}` });
    expect(read.statusCode).toBe(404);

    // Including the one call that would otherwise reach into storage on its
    // behalf. A signed URL is a bearer credential, and this is where it is
    // decided who gets one.
    const completed = await app.inject({ method: 'POST', url: `/attachments/${id}/complete` });
    expect(completed.statusCode).toBe(404);
  });
});
