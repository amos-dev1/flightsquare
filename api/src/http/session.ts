import type { FastifyRequest } from 'fastify';

import { resolveSessionToken } from '../db/auth.js';
import { hashToken } from '../tokens.js';
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
  sessionId: string;
}

export type SessionResolver = (request: FastifyRequest) => Promise<ResolvedSession>;

/**
 * Tenant statuses that may hold a live session.
 *
 * §7.3: suspended means authentication is rejected while the data stays
 * intact, and closed has started the retention clock. Both stop at the door,
 * and because the check is here it reaches every entry point at once.
 */
const USABLE_TENANT_STATUSES = new Set(['trial', 'active', 'past_due']);

/**
 * The one place a request becomes a session.
 *
 * The bearer token is read from a header, and that is not the thing §1.1
 * forbids. A credential has to arrive from the client somehow; what must
 * never come from the request is the *tenant id*. Here the token is only a
 * lookup key — the user and the selected tenant come back from the session
 * row, resolved server-side, and a caller cannot influence which tenant they
 * land in by editing anything they send.
 */
export const resolveSession: SessionResolver = async (request) => {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError();
  }

  const token = header.slice('Bearer '.length).trim();
  if (token === '') throw new UnauthorizedError();

  const row = await resolveSessionToken(hashToken(token));
  // Expired, revoked and never-existed are one answer.
  if (!row) throw new UnauthorizedError();

  if (row.user_status !== 'active') throw new UnauthorizedError();

  if (row.selected_tenant_id !== null) {
    // The tenant was deleted, suspended or closed since the session was
    // minted, or the member was removed from it. A club that removes someone
    // expects them out now, not when their access token happens to expire.
    if (row.tenant_status === null || !USABLE_TENANT_STATUSES.has(row.tenant_status)) {
      throw new UnauthorizedError();
    }
    if (row.membership_status !== 'active') throw new UnauthorizedError();
  }

  return {
    userId: row.user_id,
    tenantId: row.selected_tenant_id ?? undefined,
    sessionId: row.session_id,
  };
};
