import type { FastifyInstance } from 'fastify';
import type { NotificationResponse } from '@flightsquare/shared';

import { NotFoundError } from '../errors.js';

/**
 * The in-app feed (§3.8), and the dot on mockup 01's bell.
 *
 * Addressed to a membership rather than a user, because a notice about an
 * annual belongs to the club it is about and a person can be in several (§3.1).
 *
 * **No permission gate beyond membership.** Every other route in the product
 * names a resource and a level, and this one deliberately does not: a notice is
 * already addressed to exactly one person, and the policy on the table scopes
 * it to `app.current_membership_id()`. There is no level at which somebody
 * else's notifications are anybody's business, so there is nothing for a
 * permission to express — the row either belongs to you or the database does
 * not show it to you.
 *
 * Not feature-gated either. A tenant whose maintenance module was switched off
 * still has notices from before it was, and losing the bell would lose them
 * rather than hide them (§5.8 keeps the rows and returns them on re-upgrade).
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { unread?: string } }>(
    '/notifications',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
      return request.withTenant(async (trx) => {
        let query = trx
          .selectFrom('notifications')
          .select([
            'id', 'kind', 'title', 'body',
            'subject_type', 'subject_id', 'read_at', 'created_at',
          ])
          .orderBy('created_at', 'desc')
          .limit(100);

        if (request.query.unread === 'true') {
          query = query.where('read_at', 'is', null);
        }

        const rows = await query.execute();
        return rows.map((row) => ({
          ...row,
          read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
          created_at: new Date(row.created_at).toISOString(),
        })) satisfies NotificationResponse[];
      });
    },
  );

  /**
   * Read, and how many are not.
   *
   * Its own endpoint because the bell needs the count on every screen and the
   * list only when somebody opens it — fetching a hundred rows to render a dot
   * is the kind of thing that makes a tab bar feel slow.
   */
  app.get(
    '/notifications/unread-count',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        trx
          .selectFrom('notifications')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('read_at', 'is', null)
          .executeTakeFirstOrThrow(),
      );
      return { unread: Number(row.count) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
      return request.withTenant(async (trx) => {
        const result = await trx
          .updateTable('notifications')
          .set({ read_at: new Date() })
          .where('id', '=', request.params.id)
          .where('read_at', 'is', null)
          .executeTakeFirst();

        if (result.numUpdatedRows === 0n) {
          // Either it is not there, it is somebody else's — which the policy
          // makes indistinguishable, and §6 wants indistinguishable — or it
          // was already read, which is not an error worth a status code.
          const exists = await trx
            .selectFrom('notifications')
            .select('id')
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!exists) throw new NotFoundError();
        }
        return { ok: true };
      });
    },
  );

  /** Everything, in one go. The only thing anybody does with a full feed. */
  app.post(
    '/notifications/read-all',
    { config: { requiresTenant: true, permission: 'any_member' } },
    async (request) => {
      const result = await request.withTenant((trx) =>
        trx
          .updateTable('notifications')
          .set({ read_at: new Date() })
          .where('read_at', 'is', null)
          .executeTakeFirst(),
      );
      return { read: Number(result.numUpdatedRows) };
    },
  );
}
