import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { config } from '../src/config.js';
import { closeDatabase } from '../src/db/pool.js';
import { assertQuota } from '../src/db/entitlements.js';
import { withTenant } from '../src/db/context.js';
import { limitOf } from '../src/entitlements/values.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

const { Pool } = pg;
const SESSION_ID = '01920000-0000-7000-8000-0000000000e0';

/** Reach past the app to set up conditions a tenant cannot create for itself. */
async function asSuperuser<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    max: 1,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('the §1.6 gates', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;
  let tenant: Awaited<ReturnType<typeof provisionTestTenant>>;
  let pilotUser: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    tenant = await provisionTestTenant('gates');

    // A second member of the same tenant, holding Pilot rather than Admin.
    // Created out of band because a free tenant's members quota is 1 — which
    // is itself one of the things under test.
    pilotUser = await asSuperuser(async (pool) => {
      const user = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [`pilot-${Date.now()}@vitest.test`],
      );
      const bundle = await pool.query(
        `SELECT id FROM role_bundles WHERE tenant_id = $1 AND code = 'pilot'`,
        [tenant.tenant_id],
      );
      await pool.query(
        `INSERT INTO memberships (tenant_id, user_id, status, role_bundle_id)
         VALUES ($1, $2, 'active', $3)`,
        [tenant.tenant_id, user.rows[0].id, bundle.rows[0].id],
      );
      return user.rows[0].id as string;
    });

    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });

    // Routes that exist only to be gated. Registering them here also proves
    // the declarative config is what drives the behaviour.
    app.get(
      '/test/gated-feature',
      { config: { requiresTenant: true, feature: 'member_billing', permission: ['charges', 'read'] } },
      async () => ({ ok: true }),
    );
    app.get(
      '/test/needs-write',
      { config: { requiresTenant: true, permission: ['members', 'write'] } },
      async () => ({ ok: true }),
    );
    app.get(
      '/test/any-member',
      { config: { requiresTenant: true, permission: 'any_member' } },
      async () => ({ ok: true }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 404 for a capability the tenant is not entitled to', async () => {
    // A free tenant has no member_billing. The Admin *would* pass the
    // permission check, so the only thing producing a 404 is the feature gate.
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    const response = await app.inject({ method: 'GET', url: '/test/gated-feature' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('answers 404 before 403, so status codes leak nothing', async () => {
    // The Pilot fails *both* gates: no member_billing on this plan, and
    // charges is read for a Pilot but the route needs the feature first.
    // §1.6's order means they cannot tell which wall they hit — a gated
    // capability is indistinguishable from one that was never built.
    stub = { sessionId: SESSION_ID, userId: pilotUser, tenantId: tenant.tenant_id };
    const pilot = await app.inject({ method: 'GET', url: '/test/gated-feature' });

    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    const admin = await app.inject({ method: 'GET', url: '/test/gated-feature' });

    expect(pilot.statusCode).toBe(404);
    // Byte-identical to the Admin's answer: nothing about who they are, or
    // what they would have been allowed, is observable.
    expect(pilot.json()).toEqual(admin.json());
  });

  it('answers 403 when the feature is on but the level is not held', async () => {
    stub = { sessionId: SESSION_ID, userId: pilotUser, tenantId: tenant.tenant_id };
    const response = await app.inject({ method: 'GET', url: '/test/needs-write' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'forbidden',
      resource: 'members',
      level: 'write',
    });
  });

  it('lets an Admin through the same route', async () => {
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    const response = await app.inject({ method: 'GET', url: '/test/needs-write' });
    expect(response.statusCode).toBe(200);
  });

  it('lets any member reach a route that says so', async () => {
    stub = { sessionId: SESSION_ID, userId: pilotUser, tenantId: tenant.tenant_id };
    const response = await app.inject({ method: 'GET', url: '/test/any-member' });
    expect(response.statusCode).toBe(200);
  });

  it('answers 402 at a quota edge, with a body the UI can act on', async () => {
    // The tenant has two active members against a free limit of one, so the
    // next create is refused. 402 rather than 403: the remediation is a plan
    // change, and §1.6 keeps that orthogonal to 429.
    const ctx = { tenantId: tenant.tenant_id, userId: tenant.user_id };
    await expect(
      withTenant(ctx, (trx) => assertQuota(trx, 'members.active', limitOf(1))),
    ).rejects.toMatchObject({
      statusCode: 402,
    });

    try {
      await withTenant(ctx, (trx) => assertQuota(trx, 'members.active', limitOf(1)));
    } catch (error) {
      expect((error as { toBody: () => unknown }).toBody()).toEqual({
        error: 'quota_exceeded',
        quota: 'members.active',
        limit: 1,
        current: 2,
        remediation: ['upgrade', 'archive'],
      });
    }
  });

  it('reports the plan\u2019s limit even when it locks against less', async () => {
    // The invite path subtracts outstanding invitations from the limit,
    // because five pending invites on a limit of five would all pass. That
    // is the right thing to enforce and the wrong thing to report: "your
    // plan allows 0 members" is not true of any plan, and §1.6 puts these
    // numbers in the body so a screen can say something a person can act on.
    const ctx = { tenantId: tenant.tenant_id, userId: tenant.user_id };
    try {
      await withTenant(ctx, (trx) =>
        assertQuota(trx, 'members.active', limitOf(0), 1),
      );
      throw new Error('the quota did not refuse');
    } catch (error) {
      expect((error as { toBody: () => { limit: number } }).toBody().limit).toBe(1);
    }
  });

  it('does not refuse when the quota is unlimited', async () => {
    const ctx = { tenantId: tenant.tenant_id, userId: tenant.user_id };
    await expect(
      withTenant(ctx, (trx) =>
        assertQuota(trx, 'members.active', { kind: 'unlimited' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('reports resolved entitlements, with the layer that supplied each', async () => {
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    const response = await app.inject({ method: 'GET', url: '/entitlements' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.plan_code).toBe('free');
    expect(body.flags.member_billing).toBe(false);
    expect(body.quotas['aircraft.active']).toEqual({ limit: 1, source: 'plan' });
    // §4.5 counts in the database; this is the count coming back out, so a
    // screen can say "2 of 1" rather than waiting for somebody to walk into
    // a 402. Over the limit is a state the tenant can see, not only hit.
    expect(body.quotas['members.active']).toEqual({
      limit: 1,
      source: 'plan',
      current: 2,
    });
    // §4.3 gives maintenance to every tier, so no plan row says so.
    expect(body.flags.maintenance_module).toBe(true);
    expect(body.quotas['history.retention_days']).toEqual({
      limit: 'unlimited',
      source: 'default',
    });
    expect(body.permissions.members).toBe('write');
  });
});

describe('the boot-time guard', () => {
  /**
   * §1.5 has no "authenticated therefore allowed" default. A forgotten check
   * fails open and nothing says so, which is why this is caught at
   * registration rather than left to review.
   */
  it('refuses a tenant-scoped route that declares no permission', () => {
    const app = buildServer();
    expect(() =>
      app.get('/test/forgot', { config: { requiresTenant: true } }, async () => ({})),
    ).toThrow(/declares no permission/);
  });

  it('refuses a permission that would never be checked', () => {
    const app = buildServer();
    expect(() =>
      app.get(
        '/test/pointless',
        { config: { requiresSession: true, permission: ['aircraft', 'read'] } },
        async () => ({}),
      ),
    ).toThrow(/not requiresTenant/);
  });
});
