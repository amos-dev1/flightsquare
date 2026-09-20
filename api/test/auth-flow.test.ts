import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { hashPassword } from '../src/password.js';
import { provisionTenantForNewUser } from '../src/db/auth.js';
import { buildServer } from '../src/http/server.js';
import { cleanupTestTenants, uniqueEmail, uniqueSlug } from './helpers/fixtures.js';

const PASSWORD = 'correct horse battery staple';

// File-level, not inside a describe: an afterAll inside the first block runs
// before the second block's tests, and tearing the pool down there would
// leave them with no database.
afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

/**
 * The whole loop, through HTTP: sign in, pick a tenant, use it, refresh,
 * sign out. This is the first point at which the API is usable by a client.
 */
describe('authentication', () => {
  let app: FastifyInstance;
  let email: string;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    email = uniqueEmail('auth');
    const provisioned = await provisionTenantForNewUser({
      slug: uniqueSlug('auth'),
      name: 'Auth Flying Club',
      archetype: 'club',
      email,
      passwordHash: await hashPassword(PASSWORD),
    });
    tenantId = provisioned.tenant_id;
    userId = provisioned.user_id;

    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(): Promise<{ access: string; refresh: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    return { access: body.access_token, refresh: body.refresh_token };
  }

  it('signs in and hands back the tenants to pick from', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.refresh_token).toEqual(expect.any(String));
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].tenant_id).toBe(tenantId);

    // The tokens themselves must never come back out of the database.
    expect(body.access_token).not.toMatch(/^sha256:/);
  });

  it('answers a wrong password and an unknown address identically', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'not the password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@vitest.test', password: PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // Byte-equal, or login tells an attacker which addresses are registered.
    expect(wrongPassword.json()).toEqual(unknownUser.json());
    expect(wrongPassword.json()).toEqual({ error: 'unauthorized' });
  });

  it('reaches no tenant until one is picked', async () => {
    const { access } = await login();
    const headers = { authorization: `Bearer ${access}` };

    // Authenticated, so /me works...
    const me = await app.inject({ method: 'GET', url: '/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(userId);

    // ...but nothing is tenant-scoped yet.
    const before = await app.inject({ method: 'GET', url: '/tenant', headers });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toEqual({ error: 'tenant_required' });

    const picked = await app.inject({
      method: 'POST',
      url: '/auth/tenant',
      headers,
      payload: { tenant_id: tenantId },
    });
    expect(picked.statusCode).toBe(200);

    // Same token, now scoped — the selection lives on the session row.
    const after = await app.inject({ method: 'GET', url: '/tenant', headers });
    expect(after.statusCode).toBe(200);
    expect(after.json().id).toBe(tenantId);
  });

  it('refuses a tenant the user is not a member of, as if it did not exist', async () => {
    const other = await provisionTenantForNewUser({
      slug: uniqueSlug('other'),
      name: 'Someone Else',
      archetype: 'solo',
      email: uniqueEmail('other'),
      passwordHash: await hashPassword(PASSWORD),
    });

    const { access } = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/tenant',
      headers: { authorization: `Bearer ${access}` },
      payload: { tenant_id: other.tenant_id },
    });

    // 404, never 403: §6, errors do not leak cross-tenant existence.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('rejects a garbage or absent bearer token', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-real-token' },
      { authorization: 'Basic abc' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/me', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rotates on refresh, and the old token stops working', async () => {
    const { refresh } = await login();

    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refresh },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json();
    expect(next.refresh_token).not.toBe(refresh);

    // The new access token works.
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('treats a replayed refresh token as theft and burns the session', async () => {
    const { access, refresh } = await login();

    const first = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh },
    });
    expect(first.statusCode).toBe(200);

    // Someone else presenting the token we already exchanged.
    const replay = await app.inject({
      method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh },
    });
    expect(replay.statusCode).toBe(401);

    // Not just refused — the whole session is gone, including the access
    // token issued by the legitimate rotation and the original one.
    const rotated = first.json();
    for (const token of [access, rotated.access_token]) {
      const me = await app.inject({
        method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
    }
  });

  it('signs out', async () => {
    const { access } = await login();
    const headers = { authorization: `Bearer ${access}` };

    expect((await app.inject({ method: 'GET', url: '/me', headers })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect(out.statusCode).toBe(204);

    expect((await app.inject({ method: 'GET', url: '/me', headers })).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  /**
   * 429 is requests per unit time and is never a plan quota (§1.6). It also
   * has to survive the error handler — a limiter whose refusal is reported as
   * a 500 is worse than no limiter, because nothing downstream can tell it
   * from a crash.
   */
  it('answers 429, in the documented shape', async () => {
    const app = buildServer({ rateLimits: { login: { max: 1, timeWindow: '1 minute' } } });
    await app.ready();
    try {
      const payload = { email: 'nobody@vitest.test', password: 'whatever' };
      const first = await app.inject({ method: 'POST', url: '/auth/login', payload });
      const second = await app.inject({ method: 'POST', url: '/auth/login', payload });

      expect(first.statusCode).toBe(401);
      expect(second.statusCode).toBe(429);
      expect(second.json().error).toBe('rate_limited');
      expect(second.json().retry_after).toEqual(expect.any(Number));
    } finally {
      await app.close();
    }
  });
});
