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
   *
   * `any_member`, not `settings: read`. This returns the name, slug,
   * archetype and branding of the club you are standing in — everything a
   * client needs to render a header, and nothing settings-shaped. Requiring
   * `settings: read` locked every Pilot out of the entire web app: the app
   * shell reads this on every page, the Pilot bundle grants `settings: none`,
   * and a 403 there is indistinguishable from an expired session, so they
   * were bounced to the login screen in a loop. §1.5 wants the check to be
   * explicit, not to be the strictest one available.
   */
  app.get(
    '/tenant',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
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
    },
  );
}
