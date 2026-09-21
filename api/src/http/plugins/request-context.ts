import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { withSession, type Tx } from '../../db/context.js';
import { loadEntitlements, loadPermissions } from '../../db/entitlements.js';
import type { Entitlements } from '../../entitlements/resolver.js';
import type { FlagKey } from '../../entitlements/registry.js';
import type { Permissions, RequiredLevel, Resource } from '../../permissions.js';
import { NotFoundError, TenantRequiredError, UnauthorizedError } from '../errors.js';
import { resolveSession as defaultResolver, type ResolvedSession, type SessionResolver } from '../session.js';

/**
 * What a tenant-scoped route requires of the caller.
 *
 * `'any_member'` is for routes every member of the tenant may reach —
 * reading your own entitlements, or the name of the club you are standing
 * in. It exists so that "no particular level" is a decision someone wrote
 * down rather than a line they forgot.
 *
 * It is not an opt-out of the gate: membership is still checked, because a
 * session naming a tenant its user never joined must not read that tenant.
 */
export type PermissionRequirement = readonly [Resource, RequiredLevel] | 'any_member';

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until a route opts in with `config: { requiresSession: true }`. */
    ctx: ResolvedSession | null;
    /** Run inside this request's tenant. Throws if no tenant is in the session. */
    withTenant<T>(fn: (trx: Tx) => Promise<T>): Promise<T>;
    /** Run with user context only — the state before a tenant is picked. */
    withUser<T>(fn: (trx: Tx) => Promise<T>): Promise<T>;
    /**
     * This tenant's resolved entitlements and this member's permissions,
     * loaded once per request (§1.4) by the gate and reusable by the handler.
     */
    gates: RequestGates | null;
    /** Load the gates on demand, for a handler that needs them ungated. */
    loadGates(): Promise<RequestGates>;
  }

  interface FastifyContextConfig {
    /**
     * Opt a route into session resolution. Absent means public: /health and
     * signup have no session by definition — signup is how you get one.
     */
    requiresSession?: boolean;
    /**
     * Opt a route into tenant scope. Implies requiresSession, and obliges the
     * route to declare a permission — boot fails otherwise.
     */
    requiresTenant?: boolean;
    /** The capability this route lives behind. Absent means ungated. */
    feature?: FlagKey;
    /** What the caller must hold. Required on every requiresTenant route. */
    permission?: PermissionRequirement;
  }
}

export interface RequestGates {
  entitlements: Entitlements;
  permissions: Permissions;
}

/**
 * §1.5 has no "authenticated therefore allowed" default, and a forgotten
 * check fails *open* — the endpoint simply works for everyone, and nothing
 * says so. Catching it at registration rather than in review is the only way
 * that stays true as the surface grows.
 *
 * Installed synchronously by buildServer rather than from inside this plugin:
 * onRoute only fires for routes added after the hook exists, and a plugin
 * registered with app.register() is not processed until ready(). A route
 * added directly on the instance before then would have slipped past.
 */
export function assertRouteGatesDeclared(route: {
  method: string | string[];
  url: string;
  config?: { requiresTenant?: boolean; permission?: unknown } | undefined;
}): void {
  const config = route.config;
  if (config?.requiresTenant === true && config.permission === undefined) {
    throw new Error(
      `${String(route.method)} ${route.url} requires a tenant but declares no permission. ` +
        "Declare one, or 'any_member' if every member of the tenant may reach it.",
    );
  }
  if (config?.requiresTenant !== true && config?.permission !== undefined) {
    throw new Error(
      `${String(route.method)} ${route.url} declares a permission but not requiresTenant, ` +
        'so the permission would never be checked.',
    );
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

  app.decorateRequest('gates', null);

  app.decorateRequest('loadGates', async function (this: FastifyRequest): Promise<RequestGates> {
    if (this.gates) return this.gates;
    // One transaction, one load, reused for the rest of the request — §1.4's
    // per-request cache, and the reason invalidation is trivially correct.
    const gates = await this.withTenant(async (trx) => ({
      entitlements: await loadEntitlements(trx),
      permissions: await loadPermissions(trx, requireSession(this).userId),
    }));
    this.gates = gates;
    return gates;
  });

  app.addHook('preHandler', async (request) => {
    const config = request.routeOptions.config;
    const needsSession = config?.requiresSession === true || config?.requiresTenant === true;
    if (!needsSession) return;

    request.ctx = await resolve(request);

    if (config?.requiresTenant !== true) return;
    const ctx = requireSession(request);
    if (!ctx.tenantId) throw new TenantRequiredError();

    const gates = await request.loadGates();

    /**
     * Membership first, whatever else the route asks for.
     *
     * `'any_member'` used to skip the gate entirely, which made it mean "no
     * check" rather than "any member" — and the `tenants` policy keys on
     * `app.current_tenant_id()` alone, so a session naming a tenant its user
     * never joined would have read that tenant's row. The permission load
     * was the only thing standing in the way, and opting out of it opted out
     * of that too.
     *
     * `tenant_required` rather than `forbidden`: the session's tenant is not
     * one this user can act in, which is a statement about the session, not
     * about a level they are missing. §6 — it also says nothing about
     * whether that tenant exists.
     */
    if (!gates.permissions.isMember) throw new TenantRequiredError();

    /**
     * §1.6's order, and the order is the point.
     *
     * Feature first, so a tenant without a module cannot tell from status
     * codes whether the module exists, whether they would be allowed to use
     * it, or how close to a limit they are. A gated capability has to be
     * indistinguishable from one that was never built. Quota is third and
     * lives in the handler, because its row lock belongs in the write
     * transaction (§4.5).
     */
    if (config.feature !== undefined && !gates.entitlements.flag(config.feature)) {
      // 404, never 402 — upsell copy belongs in the UI, reached through the
      // entitlement data the client already has, not through a status code.
      throw new NotFoundError();
    }

    if (config.permission !== undefined && config.permission !== 'any_member') {
      const [resource, level] = config.permission;
      gates.permissions.require(resource, level);
    }
  });
}

export const requestContext = fp(requestContextPlugin, {
  name: 'request-context',
  fastify: '5.x',
});
