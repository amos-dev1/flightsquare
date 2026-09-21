import { NotFoundError } from '../http/errors.js';
import type { Tx } from './context.js';

/**
 * The caller's own membership in whichever tenant the session is scoped to.
 *
 * No tenant predicate, because there is no need for one: the query runs
 * inside tenant context and the policy on `memberships` is what scopes it
 * (§1.1). A user who belongs to three clubs has three membership rows and
 * this returns the one that belongs to the tenant of this request.
 *
 * Not-found rather than a friendlier error: a session whose user has no
 * active membership in the tenant it selected has no business here, and §6
 * says errors do not distinguish "absent" from "not yours".
 */
export async function ownMembership(trx: Tx, userId: string): Promise<string> {
  const row = await trx
    .selectFrom('memberships')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) throw new NotFoundError();
  return row.id;
}
