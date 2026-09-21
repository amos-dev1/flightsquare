import type { FastifyInstance } from 'fastify';
import type { MeResponse, MembershipSummaryResponse } from '@flightsquare/shared';

import { listMembershipsForUser } from '../../db/auth.js';
import { UnauthorizedError } from '../errors.js';

/**
 * The two things a session can do before it has picked a tenant.
 *
 * Both return 401 today: resolveSession() throws until the sessions table
 * exists. That is the middleware working, not a gap.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The caller's own row, read under user context with no tenant set.
   *
   * §3.1 says a user with no memberships is valid — just invited, or removed
   * from their last org — so membership cannot be the only route to one's own
   * record. Migration 0003's users policy has a self arm for exactly this.
   */
  app.get('/me', { config: { requiresSession: true } }, async (request) => {
    const user = await request.withUser((trx) =>
      trx
        .selectFrom('users')
        .select(['id', 'email', 'name', 'phone', 'mfa_enabled', 'email_verified_at'])
        .executeTakeFirst(),
    );

    // The session named a user the database cannot see. Treat it as no
    // session at all rather than reporting on whose account it was.
    if (!user) throw new UnauthorizedError();

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      mfa_enabled: user.mfa_enabled,
      email_verified: user.email_verified_at !== null,
    } satisfies MeResponse;
  });

  /**
   * The tenant picker. Spans tenants for one user by design (§3.1), which is
   * why it goes through the §2.1 function rather than a query: with no tenant
   * context a direct read of memberships correctly returns nothing.
   */
  app.get('/me/memberships', { config: { requiresSession: true } }, async (request) => {
    // Non-null: the preHandler set it, or this handler never ran.
    const ctx = request.ctx!;
    const memberships = await listMembershipsForUser(ctx.userId);
    return memberships satisfies MembershipSummaryResponse[];
  });
}
