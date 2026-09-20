import type { FastifyInstance } from 'fastify';

import { NotFoundError } from '../errors.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The current tenant, read under tenant context.
   *
   * Note there is no tenant id anywhere in this handler — not in the path,
   * not in a parameter, not passed to withTenant. That is the point of the
   * middleware: the only tenant this code can reach is the one the session
   * resolved to, and row-level security is what actually enforces it.
   */
  app.get('/tenant', { config: { requiresSession: true } }, async (request) => {
    const tenant = await request.withTenant((trx) =>
      trx
        .selectFrom('tenants')
        .select(['id', 'slug', 'name', 'archetype', 'branding'])
        .executeTakeFirst(),
    );

    // A suspended or soft-deleted tenant falls out of the policy and lands
    // here. 404, never "your account is suspended" — §6: errors do not leak
    // cross-tenant existence, and this path cannot tell the two apart.
    if (!tenant) throw new NotFoundError();

    return tenant;
  });
}
