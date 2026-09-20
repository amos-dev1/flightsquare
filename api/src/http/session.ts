import type { FastifyRequest } from 'fastify';

import { UnauthorizedError } from './errors.js';

/**
 * Who a request is for, once the session has been resolved.
 *
 * userId is present from authentication onwards. tenantId is absent between
 * authenticating and picking a tenant — a real state, not an edge case: a
 * user may belong to several tenants (§3.1) and a user with no memberships at
 * all is valid.
 */
export interface ResolvedSession {
  userId: string;
  tenantId?: string | undefined;
}

export type SessionResolver = (request: FastifyRequest) => Promise<ResolvedSession>;

/**
 * The one place a request turns into a session. Everything tenant-scoped
 * depends on it, and it is deliberately the only such place.
 *
 * §1.1: both ids are resolved server-side. Neither ever comes from a request
 * header, query parameter, path segment or JSON body — not for convenience,
 * not for admin tooling, not behind a feature flag. The moment a tenant id
 * can be named by the caller, row-level security is enforcing whatever the
 * caller asked for.
 *
 * It throws today because there is no session model yet: no sessions table,
 * no token verification. That is the correct behaviour — the middleware runs
 * and fails closed — and this function becomes real in the same change that
 * adds the sessions table. Per §10 that table carries a session_type
 * discriminator from the start, so impersonation (§7.5) can be added later
 * without retrofitting a second session type.
 */
export const resolveSession: SessionResolver = async () => {
  throw new UnauthorizedError();
};
