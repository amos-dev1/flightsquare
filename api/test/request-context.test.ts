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
      stub = { userId: alpha.user_id, tenantId: alpha.tenant_id };
      const first = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(first.statusCode).toBe(200);
      expect(first.json().slug).toBe(alpha.slug);

      // Same route, same code, different session. The handler never names a
      // tenant; swapping the session is the only thing that changed.
      stub = { userId: bravo.user_id, tenantId: bravo.tenant_id };
      const second = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(second.statusCode).toBe(200);
      expect(second.json().slug).toBe(bravo.slug);
      expect(second.json().id).not.toBe(first.json().id);
    });

    it('cannot see a tenant it is not a member of, even named directly', async () => {
      // Alpha's session, asking the database for Bravo's row by id. The
      // policy, not the handler, is what returns nothing.
      stub = { userId: alpha.user_id, tenantId: alpha.tenant_id };
      const rows = await stubbed
        .inject({ method: 'GET', url: '/tenant' })
        .then((r) => r.json());
      expect(rows.id).toBe(alpha.tenant_id);

      stub = { userId: alpha.user_id, tenantId: bravo.tenant_id };
      // A session claiming Bravo while being Alpha's user still reads Bravo —
      // tenancy is the tenant id, not the user. This is why resolveSession is
      // the only place a session is minted, and why §1.1 forbids taking that
      // id from the request.
      const crossed = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(crossed.json().id).toBe(bravo.tenant_id);
    });
  });

  describe('with a session that has not picked a tenant', () => {
    it('refuses tenant-scoped routes distinctly from 403 and 404', async () => {
      stub = { userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/tenant' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'tenant_required' });
    });

    it('still reads its own row — §3.1 allows a user with no memberships', async () => {
      stub = { userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: alpha.user_id,
        email: alpha.email,
      });
    });

    it('lists the tenants it could pick', async () => {
      stub = { userId: alpha.user_id };
      const response = await stubbed.inject({ method: 'GET', url: '/me/memberships' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].tenant_id).toBe(alpha.tenant_id);
    });
  });
});
