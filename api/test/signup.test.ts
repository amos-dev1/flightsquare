import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import { cleanupTestTenants, uniqueEmail, uniqueSlug } from './helpers/fixtures.js';

describe('POST /auth/signup', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await closeDatabase();
  });

  it('reports healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('creates a tenant, a user and a membership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        slug: uniqueSlug('signup'),
        name: 'Signup Flying Club',
        email: uniqueEmail('signup'),
        password: 'correct horse battery staple',
        archetype: 'club',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.tenant_id).toEqual(expect.any(String));
    expect(body.user_id).toEqual(expect.any(String));
    expect(body.membership_id).toEqual(expect.any(String));
  });

  it('answers a taken slug and a registered email identically', async () => {
    const slug = uniqueSlug('dup');
    const email = uniqueEmail('dup');
    const password = 'correct horse battery staple';

    const first = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { slug, name: 'First', email, password },
    });
    expect(first.statusCode).toBe(201);

    // Same slug, different email.
    const slugClash = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { slug, name: 'Second', email: uniqueEmail('dup2'), password },
    });

    // Same email, different slug.
    const emailClash = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { slug: uniqueSlug('dup2'), name: 'Third', email, password },
    });

    expect(slugClash.statusCode).toBe(409);
    expect(emailClash.statusCode).toBe(409);
    // Indistinguishable, or signup becomes an account-existence oracle.
    expect(slugClash.json()).toEqual(emailClash.json());
  });

  it('turns away a client older than the floor (§8.1)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-flightsquare-client': 'ios',
        'x-flightsquare-client-version': '0.9.0',
      },
    });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      error: 'client_too_old',
      client: 'ios',
      minimum_version: '1.4.0',
    });
  });

  it('lets a current client through, and one with no floor set', async () => {
    const current = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-flightsquare-client': 'ios',
        'x-flightsquare-client-version': '1.4.0',
      },
    });
    expect(current.statusCode).toBe(200);

    const unknownClient = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-flightsquare-client': 'web',
        'x-flightsquare-client-version': '0.0.1',
      },
    });
    expect(unknownClient.statusCode).toBe(200);
  });

  it('rejects a malformed body before touching the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { slug: 'Not A Slug', name: '', email: 'nope', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('never reflects a database message to the client', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        slug: uniqueSlug('leak'),
        name: 'Leak Check',
        email: uniqueEmail('leak'),
        password: 'correct horse battery staple',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toMatch(/postgres|relation|constraint|pg_/i);
  });
});
