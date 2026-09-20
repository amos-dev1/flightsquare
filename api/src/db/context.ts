import { type Transaction, sql } from 'kysely';

import { db } from './pool.js';
import type { Database } from './schema.js';

/**
 * Who the request is for. Both values are resolved server-side from the
 * authenticated session. Neither ever comes from a request header, query
 * parameter, path segment or JSON body, "just for admin tooling" included
 * (§1.1).
 */
export interface SessionContext {
  tenantId?: string | undefined;
  /** Present from authentication onwards, including before a tenant is picked. */
  userId?: string | undefined;
}

export type Tx = Transaction<Database>;

/**
 * The only way into the database, and the reason §9 disqualifies an ORM that
 * hides transaction boundaries.
 *
 * Context is set with set_config(..., is_local => true) — the SET LOCAL of
 * §1.1 — so it dies with the transaction. Under transaction pooling a plain
 * SET would leak one tenant's context onto whichever request borrows the
 * connection next, which is the failure the whole design exists to prevent.
 *
 * Absent values are sent as the empty string rather than omitted: the policy
 * accessors read '' as "unset" (that is what the NULLIF in them is for), so
 * an unset tenant means zero rows rather than a cast error mid-request.
 */
export async function withSession<T>(
  ctx: SessionContext,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`
      SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true),
             set_config('app.user_id',   ${ctx.userId ?? ''}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** A request acting inside a tenant. The ordinary case. */
export async function withTenant<T>(
  ctx: { tenantId: string; userId: string },
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  return withSession(ctx, fn);
}

/**
 * Authenticated, but no tenant chosen yet — the state between the credential
 * check and the tenant picker. A user can read their own row here and
 * nothing else; see the users policy in migration 0003.
 */
export async function withUser<T>(
  userId: string,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  return withSession({ userId }, fn);
}
