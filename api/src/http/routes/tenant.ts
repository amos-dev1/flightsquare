import type { FastifyInstance } from 'fastify';

import { InvalidRequestError, NotFoundError } from '../errors.js';

const settingsSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      /** An IANA zone. Validated against the runtime's own list, below. */
      timezone: { type: 'string', maxLength: 64 },
    },
  },
} as const;

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
        .select(['id', 'slug', 'name', 'archetype', 'timezone', 'branding', 'status'])
        .executeTakeFirst(),
    );

    // A suspended or soft-deleted tenant falls out of the policy and lands
    // here. 404, never "your account is suspended" — §6: errors do not leak
    // cross-tenant existence, and this path cannot tell the two apart.
    if (!tenant) throw new NotFoundError();

      return tenant;
    },
  );

  /**
   * Settings: the name on the door and the zone its clocks are read in.
   *
   * Not the slug — it is in URLs and in invite links already out in the
   * world — and not the archetype, which §3.1 keeps descriptive and which
   * nothing may read at runtime anyway. Both are `never` on the write side
   * of the schema type, so this is a compile error away rather than a review
   * comment away.
   */
  app.patch<{ Body: { name?: string; timezone?: string } }>(
    '/tenant',
    {
      schema: settingsSchema,
      config: { requiresTenant: true, permission: ['settings', 'write'] },
    },
    async (request) => {
      const { name, timezone } = request.body;
      if (timezone !== undefined && !isKnownTimeZone(timezone)) {
        throw new InvalidRequestError(`${timezone} is not a time zone this server knows`);
      }

      /**
       * Built from the keys this route owns rather than from the body.
       *
       * Fastify's validator *strips* unknown properties rather than
       * rejecting them, so a request naming `slug` arrives here as an empty
       * object — and passing that straight to `set()` is a statement with no
       * columns, which surfaces as a 500 for what is a client mistake.
       */
      const changes = {
        ...(name !== undefined ? { name } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
      };
      if (Object.keys(changes).length === 0) {
        throw new InvalidRequestError('nothing here can be changed — only name and timezone');
      }

      const tenant = await request.withTenant(async (trx) => {
        await trx.updateTable('tenants').set(changes).execute();
        return trx
          .selectFrom('tenants')
          .select(['id', 'slug', 'name', 'archetype', 'timezone', 'branding', 'status'])
          .executeTakeFirst();
      });

      if (!tenant) throw new NotFoundError();
      return tenant;
    },
  );
}

/**
 * Checked against the runtime rather than a list of our own.
 *
 * A zone nobody can resolve is worse than no zone at all: every screen that
 * formats a time would throw, and the tenant would have no way back because
 * settings is one of those screens.
 */
function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
