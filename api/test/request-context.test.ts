import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * The middleware everything tenant-scoped depends on.
 *
 * The point of these tests is not that Fastify hooks work — it is that a
 * route physically cannot reach a tenant other than the one the session
 * resolved to, and that with no session it reaches nothing at all.
 */
describe('request context', () => {
  let alpha: Awaited<ReturnType<typeof provisionTestTenant>>;
  let bravo: Awaited<ReturnType<typeof provisionTestTenant>>;

  /** The stub the injected resolver hands back; null means "no session". */
  let stub: ResolvedSession | null = null;

  // These tests are about what the middleware does with a session, not about
  // where it came from, so the session id is a fixed placeholder.
  const SESSION_ID = '01920000-0000-7000-8000-00000000000f';

  let real: FastifyInstance;
  let stubbed: FastifyInstance;

  beforeAll(async () => {
    await cleanupTestTenants();
    alpha = await provisionTestTenant('ctx-alpha');
    bravo = await provisionTestTenant('ctx-bravo');

    // One server with the production resolver, one with an injectable stub.
    real = buildServer();
    stubbed = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await Promise.all([real.ready(), stubbed.ready()]);
  });

  afterAll(async () => {
    await Promise.all([real.close(), stubbed.close()]);
    await cleanupTestTenants();
    await closeDatabase();
  });

  describe('with the real resolver', () => {
    it('fails closed on every session-scoped route', async () => {
      for (const url of ['/me', '/me/memberships', '/tenant']) {
        const response = await real.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
        expect(response.json()).toEqual({ error: 'unauthorized' });
      }
    });

    it('leaves public routes alone', async () => {
      // /health and signup have no session by definition — signup is how you
      // get one — so the preHandler must not run for them.
      const response = await real.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    });

    it('says nothing about why there is no session', async () => {
      const response = await real.inject({ method: 'GET', url: '/tenant' });
      expect(response.body).not.toMatch(/session model|not implemented|table/i);
    });
  });

  describe('with a tenant-scoped session', () => {
    it('reads the tenant the session resolved to, and no other', async () => {
      stub = { sessionId: SESSION_ID, userId: alpha.user_id, tenantId: alpha.tenant_id };
      const first = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(first.statusCode).toBe(200);
      expect(first.json().slug).toBe(alpha.slug);

      // Same route, same code, different session. The handler never names a
      // tenant; swapping the session is the only thing that changed.
      stub = { sessionId: SESSION_ID, userId: bravo.user_id, tenantId: bravo.tenant_id };
      const second = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(second.statusCode).toBe(200);
      expect(second.json().slug).toBe(bravo.slug);
      expect(second.json().id).not.toBe(first.json().id);
    });

    it('cannot use a tenant the user is not a member of', async () => {
      stub = { sessionId: SESSION_ID, userId: alpha.user_id, tenantId: alpha.tenant_id };
      const ours = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(ours.json().id).toBe(alpha.tenant_id);

      // A session claiming Bravo's tenant while being Alpha's user. Before
      // permissions existed this read Bravo's row — tenancy was the tenant id
      // and nothing checked that the user belonged there. The gate now asks
      // for the membership itself, so two independent things have to agree
      // before anything is read.
      //
      // The policy on `tenants` keys on app.current_tenant_id() alone, which
      // is why this check cannot be skipped: /tenant asks for no particular
      // level — every member may know which club they are in — and if
      // "no level required" meant "no gate", this request would succeed.
      stub = { sessionId: SESSION_ID, userId: alpha.user_id, tenantId: bravo.tenant_id };
      const crossed = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(crossed.statusCode).toBe(403);
      // A statement about the session, not about a level they are missing —
      // and, per §6, it says nothing about whether that tenant exists.
      expect(crossed.json()).toEqual({ error: 'tenant_required' });
    });
  });

  describe('with a session that has not picked a tenant', () => {
    it('refuses tenant-scoped routes distinctly from 403 and 404', async () => {
      stub = { sessionId: SESSION_ID, userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'tenant_required' });
    });

    it('still reads its own row — §3.1 allows a user with no memberships', async () => {
      stub = { sessionId: SESSION_ID, userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: alpha.user_id,
        email: alpha.email,
      });
    });

    it('lists the tenants it could pick', async () => {
      stub = { sessionId: SESSION_ID, userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/me/memberships' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].tenant_id).toBe(alpha.tenant_id);
    });
  });
});
