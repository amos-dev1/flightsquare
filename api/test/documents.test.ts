import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { withTenant } from '../src/db/context.js';
import { buildServer } from '../src/http/server.js';
import { ensureBucket } from '../src/storage/index.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { addTestMember, cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

const SESSION_ID = '01920000-0000-7000-8000-0000000000d0';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * Aircraft documents (§3.2), and the four decisions that shaped them.
 *
 * The AROW set is the point: a pilot is responsible for the airworthiness
 * certificate, registration, operating limitations and weight and balance being
 * aboard, and until now had to take it on trust. Insurance is here because it is
 * the one a club actually chases.
 *
 * What this suite is really asserting is the shape rather than the storage —
 * `attachments.test.ts` already covers the three-step upload. Here: the
 * `documents` resource in both directions, that a renewal supersedes rather than
 * overwrites, that removal is a status and not a delete, and the one that
 * matters most — an expired document does not ground an aeroplane.
 *
 * Needs the `storage` service from docker-compose.
 */
describe('aircraft documents', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;
  let other: Awaited<ReturnType<typeof provisionTestTenant>>;
  let aircraftId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await ensureBucket();

    tenant = await provisionTestTenant('docs-a');
    other = await provisionTestTenant('docs-b');

    // §4.4 is enforced by a trigger: a club keeps one member who can manage
    // members. This suite demotes its own membership to Pilot to test the §1.5
    // line, so the club needs a second Admin to still be a club afterwards.
    await addTestMember(tenant.tenant_id, 'docs-spare-admin', 'admin');

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();

    asAdmin();
    aircraftId = (
      await app.inject({
        method: 'POST',
        url: '/aircraft',
        payload: { registration: 'N77DOC', type_code: 'SR22' },
      })
    ).json().id;
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

  function file(documentId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/aircraft-documents/${documentId}/attachments`,
      payload,
    });
  }

  it('files a document, then its file, and hands back a signed link', async () => {
    asAdmin();
    await setBundle('admin');

    /*
      The document first, which is the order the foreign key enforces: the owner
      exists and the upload names it. It is also a real state — "the insurance
      expires on 31 March and nobody has scanned it yet" is a thing a club knows
      before it has the PDF.
    */
    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: {
        kind: 'insurance',
        title: 'Hull and liability 2026',
        reference: 'POL-99413',
        issued_on: '2026-01-01',
        expires_on: '2026-12-31',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().attachments).toEqual([]);
    expect(created.json().superseded).toBe(false);
    const documentId = created.json().id as string;

    // A PDF, which is what a broker emails and which the allowed types learned
    // for exactly this.
    const signed = await file(documentId, {
      content_type: 'application/pdf',
      byte_size: 240_000,
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json().aircraft_document_id).toBe(documentId);
    expect(signed.json().kind).toBe('document');
    expect(signed.json().upload_url).toContain('X-Amz-Signature');

    // Nothing was uploaded, so there is nothing to complete and the API says so
    // rather than marking a row that names no object as a file.
    const premature = await app.inject({
      method: 'POST',
      url: `/aircraft-documents/${documentId}/attachments/${signed.json().id}/complete`,
    });
    expect(premature.statusCode).toBe(400);
  });

  it('refuses a file type it does not take, and one too large', async () => {
    asAdmin();
    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: { kind: 'weight_balance', title: 'W&B after avionics install' },
    });
    const documentId = created.json().id as string;

    const spreadsheet = await file(documentId, {
      content_type: 'application/vnd.ms-excel',
      byte_size: 1024,
    });
    expect(spreadsheet.statusCode).toBe(400);

    const huge = await file(documentId, {
      content_type: 'application/pdf',
      byte_size: 64 * 1024 * 1024,
    });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().detail).toContain('larger than');
  });

  it('supersedes a certificate rather than overwriting it', async () => {
    asAdmin();

    const first = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: {
        kind: 'registration',
        title: 'Registration 2019',
        issued_on: '2019-05-01',
        expires_on: '2026-05-31',
      },
    });
    const firstId = first.json().id as string;

    const renewal = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: {
        kind: 'registration',
        title: 'Registration 2026',
        issued_on: '2026-05-01',
        expires_on: '2033-05-31',
        supersedes_id: firstId,
      },
    });
    expect(renewal.statusCode).toBe(201);
    expect(renewal.json().supersedes_id).toBe(firstId);

    /*
      The old one is still there, still has its dates, and now reports that
      something replaced it.

      `superseded` is derived from the absence of anything naming the row, not
      stored on it — which is why two current registrations is not a state this
      can report. The 2019 certificate is also what answers a question about
      2019, so it is not removed.
    */
    const list = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}/documents` });
    const registrations = (
      list.json() as { id: string; title: string; superseded: boolean; expires_on: string }[]
    ).filter((row) => row.title.startsWith('Registration '));

    const old = registrations.find((row) => row.id === firstId)!;
    expect(old.superseded).toBe(true);
    expect(old.expires_on).toBe('2026-05-31');
    expect(registrations.find((row) => row.id === renewal.json().id)!.superseded).toBe(false);

    // And a renewal replaces a document of its own kind. A registration
    // superseding an insurance certificate would make the list meaningless.
    const crossed = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: { kind: 'insurance', title: 'Wrong kind', supersedes_id: firstId },
    });
    expect(crossed.statusCode).toBe(400);
  });

  it('removes a document with a reason, and never deletes one', async () => {
    asAdmin();

    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: { kind: 'other', title: 'Filed against the wrong aeroplane' },
    });
    const documentId = created.json().id as string;

    const bare = await app.inject({
      method: 'PATCH',
      url: `/aircraft-documents/${documentId}`,
      payload: { status: 'removed' },
    });
    expect(bare.statusCode).toBe(400);

    const removed = await app.inject({
      method: 'PATCH',
      url: `/aircraft-documents/${documentId}`,
      payload: { status: 'removed', removed_reason: 'Belongs to the other 182' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().status).toBe('removed');
    expect(removed.json().removed_reason).toBe('Belongs to the other 182');

    // Still on the list, because §10 makes an application-facing delete a
    // status and nothing here destroys a row.
    const list = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}/documents` });
    expect((list.json() as { id: string }[]).some((row) => row.id === documentId)).toBe(true);
  });

  it('never grounds an aeroplane over a lapsed document', async () => {
    /*
      The sharpest rule in this module, and the one most likely to be
      "improved" later.

      §11 forbids inferring airworthiness from an absence of maintenance
      warnings, and the mirror binds just as hard: the club may have renewed and
      not uploaded the scan, a registration may have a renewal pending with the
      FAA, and a standard airworthiness certificate does not expire at all.
      `aircraft_availability` keeps its three inputs and the booking path never
      consults this.
    */
    asAdmin();

    await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: {
        kind: 'insurance',
        title: 'Lapsed last year',
        issued_on: '2024-01-01',
        expires_on: '2025-01-01',
      },
    });

    const dispatch = await app.inject({
      method: 'GET',
      url: `/aircraft/${aircraftId}/availability`,
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json().available).toBe(true);
    expect(dispatch.json().grounding_reasons).toEqual([]);
  });

  it('lets a pilot read the paperwork and not file any', async () => {
    /*
      `0027` seeded Pilot with `documents: read, all` and nothing has used it
      until now. SPEC §3 reads as though a pilot should see none of this; the
      grant wins, because a pilot is responsible for the AROW documents being
      aboard and the weight and balance is operationally theirs.
    */
    await setBundle('pilot');
    asAdmin();

    const list = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}/documents` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBeGreaterThan(0);

    const filed = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: { kind: 'insurance', title: 'Not a pilot\u2019s to file' },
    });
    expect(filed.statusCode).toBe(403);
    expect(filed.json().resource).toBe('documents');

    await setBundle('admin');
  });

  it('is not found in another tenant, never forbidden', async () => {
    asAdmin();
    await setBundle('admin');

    const created = await app.inject({
      method: 'POST',
      url: `/aircraft/${aircraftId}/documents`,
      payload: { kind: 'airworthiness', title: 'Standard airworthiness certificate' },
    });
    const documentId = created.json().id as string;

    // §6: "Aircraft not found" for a tail number in another tenant, never
    // "you don't have access to that aircraft".
    asOtherTenant();

    const list = await app.inject({ method: 'GET', url: `/aircraft/${aircraftId}/documents` });
    expect(list.statusCode).toBe(404);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/aircraft-documents/${documentId}`,
      payload: { title: 'Theirs now' },
    });
    expect(patched.statusCode).toBe(404);

    const attached = await file(documentId, {
      content_type: 'application/pdf',
      byte_size: 1024,
    });
    expect(attached.statusCode).toBe(404);

    asAdmin();
  });
});
