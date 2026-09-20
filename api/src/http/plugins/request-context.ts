import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { withSession, type Tx } from '../../db/context.js';
import { TenantRequiredError, UnauthorizedError } from '../errors.js';
import { resolveSession as defaultResolver, type ResolvedSession, type SessionResolver } from '../session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until a route opts in with `config: { requiresSession: true }`. */
    ctx: ResolvedSession | null;
    /** Run inside this request's tenant. Throws if no tenant is in the session. */
    withTenant<T>(fn: (trx: Tx) => Promise<T>): Promise<T>;
    /** Run with user context only — the state before a tenant is picked. */
    withUser<T>(fn: (trx: Tx) => Promise<T>): Promise<T>;
  }

  interface FastifyContextConfig {
    /**
     * Opt a route into session resolution. Absent means public: /health and
     * signup have no session by definition — signup is how you get one.
     */
    requiresSession?: boolean;
  }
}

export interface RequestContextOptions {
  /** Injectable so tests can stub a session without mocking modules. */
  resolveSession?: SessionResolver;
}

/**
 * Binds the database context to the request, so a route never names a tenant.
 *
 * This is the piece everything tenant-scoped depends on. A handler cannot
 * pass a tenant id of its own — it only has `request.withTenant(fn)`, already
 * bound to whatever the session resolved to. Getting the wrong tenant's data
 * would take editing this file, not forgetting an argument in a route.
 *
 * The transaction opens per operation rather than per request. A request-long
 * transaction would pin one pool connection for the whole request lifetime,
 * including response serialization and any external call, so a handful of
 * slow requests would exhaust the pool. Context still cannot be missing: it
 * is set by the same statement that begins the transaction, inside
 * withSession(), before any query in it runs.
 */
async function requestContextPlugin(
  app: FastifyInstance,
  options: RequestContextOptions,
): Promise<void> {
  const resolve = options.resolveSession ?? defaultResolver;

  // Decorated with null rather than an object: a decorator value is shared by
  // every request, so a mutable default would be a cross-request leak.
  app.decorateRequest('ctx', null);

  function requireSession(request: FastifyRequest): ResolvedSession {
    const ctx = request.ctx;
    if (!ctx) {
      // Either the route did not opt in, or resolution never ran. Both are
      // bugs above this layer, and both must fail closed.
      throw new UnauthorizedError();
    }
    return ctx;
  }

  app.decorateRequest('withTenant', function <T>(
    this: FastifyRequest,
    fn: (trx: Tx) => Promise<T>,
  ): Promise<T> {
    const ctx = requireSession(this);
    if (!ctx.tenantId) {
      // Authenticated, but no tenant chosen yet. Not a 404 — §1.6 reserves
      // that for capabilities the tenant is not entitled to — and not a 403
      // about permission levels either. The session is simply not yet scoped.
      throw new TenantRequiredError();
    }
    return withSession({ tenantId: ctx.tenantId, userId: ctx.userId }, fn);
  });

  app.decorateRequest('withUser', function <T>(
    this: FastifyRequest,
    fn: (trx: Tx) => Promise<T>,
  ): Promise<T> {
    const ctx = requireSession(this);
    return withSession({ userId: ctx.userId }, fn);
  });

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.config?.requiresSession !== true) return;
    request.ctx = await resolve(request);
  });
}

export const requestContext = fp(requestContextPlugin, {
  name: 'request-context',
  fastify: '5.x',
});
